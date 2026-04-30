/**
 * HyperGuard — trading app source of truth (TypeScript)
 *
 * Architecture:
 *   types     → primitives + interfaces
 *   risk      → pure risk-math (sizing, liq, score)
 *   rules     → pure rules engine (the 5 enforced rules)
 *   wallet    → window.ethereum bridge (no custody)
 *   chart     → lightweight-charts wrapper with risk-zone overlay
 *   store     → typed state container with pub/sub
 *   ui        → DOM bindings, the only place that touches the DOM
 *   bootstrap → wires it all together
 *
 * The compiled JS equivalent lives inline in app.html so the static
 * GitHub Pages deploy needs no build step. Edit this file as the
 * source of truth, then either run `tsc app.ts` or sync the inline
 * <script> in app.html.
 */

// ═══════════════ types ═══════════════════════════════════════
export type Side = 'long' | 'short';
export type Mode = 'conservative' | 'balanced' | 'aggressive';

export interface ModeConfig {
  readonly maxLeverage: number;
  readonly maxRiskPct: number;        // max % of equity per trade
  readonly minLiqBufferPct: number;   // min liq distance enforced
  readonly label: string;
}

export interface RiskInputs {
  equity: number;
  riskPct: number;
  stopPct: number;
  leverage: number;
  side: Side;
  markPrice: number;
}

export interface RiskOutputs {
  notional: number;
  margin: number;
  liqPrice: number;
  stopPrice: number;
  liqBufferPct: number;
  liqStopRatio: number;
  riskScore: number;
  dollarRisk: number;
  entry: number;
}

export interface Position {
  side: Side;
  entry: number;
  notional: number;
  margin: number;
  leverage: number;
  stopPrice: number;
  liqPrice: number;
  openedAt: number;
  riskAtEntry: number;
}

export type Verdict = 'safe' | 'warn' | 'danger';

export interface RuleViolation {
  rule: 'max_daily_loss' | 'max_daily_profit' | 'loss_cooldown' | 'sl_widen' | 'no_adding';
  severity: 'hard_stop' | 'cancel_restore' | 'auto_enforced';
  message: string;
}

export interface AccountState {
  equity: number;
  startOfDayEquity: number;
  todayPnL: number;
  cooldownUntil: number | null;
  position: Position | null;
  walletAddress: string | null;
  mode: Mode;
  ruleStatus: Partial<Record<RuleViolation['rule'], 'ok' | 'tripped'>>;
}

// ═══════════════ modes ═══════════════════════════════════════
export const MODES: Record<Mode, ModeConfig> = {
  conservative: { maxLeverage: 3,  maxRiskPct: 1, minLiqBufferPct: 20, label: 'Conservative' },
  balanced:     { maxLeverage: 5,  maxRiskPct: 2, minLiqBufferPct: 15, label: 'Balanced' },
  aggressive:   { maxLeverage: 10, maxRiskPct: 5, minLiqBufferPct: 10, label: 'Aggressive' },
};

// ═══════════════ risk ════════════════════════════════════════
/**
 * Pure risk math. All sizing follows from:
 *   notional = (equity × riskPct) / stopPct
 * which guarantees the dollar loss at stop equals exactly riskPct of equity.
 */
export function computeRisk(i: RiskInputs): RiskOutputs {
  const dir = i.side === 'long' ? 1 : -1;
  const dollarRisk = i.equity * (i.riskPct / 100);
  const notional   = dollarRisk / (i.stopPct / 100);
  const margin     = notional / i.leverage;
  const liqBufferPct = (1 / i.leverage) * 100 * 0.95;
  const liqStopRatio = liqBufferPct / i.stopPct;

  const entry = i.markPrice;
  const stopPrice = entry * (1 - dir * i.stopPct / 100);
  const liqPrice  = entry * (1 - dir * liqBufferPct / 100);

  const riskScore = scoreOf(i, liqStopRatio);

  return { notional, margin, liqPrice, stopPrice, liqBufferPct, liqStopRatio, riskScore, dollarRisk, entry };
}

function scoreOf(i: RiskInputs, liqStopRatio: number): number {
  const m = MODES[modeFromMaxLeverage(i.leverage)];
  const levScore   = Math.min(50, Math.pow(i.leverage / m.maxLeverage, 1.4) * 35);
  const ratioScore = liqStopRatio < 1 ? 40 : liqStopRatio < 2 ? 25 : liqStopRatio < 3 ? 12 : 4;
  const riskScore  = Math.min(40, Math.pow(i.riskPct / m.maxRiskPct, 1.2) * 22);
  return Math.max(0, Math.min(100, Math.round(levScore + ratioScore + riskScore)));
}

function modeFromMaxLeverage(lev: number): Mode {
  if (lev <= 3) return 'conservative';
  if (lev <= 5) return 'balanced';
  return 'aggressive';
}

export function verdictOf(score: number): Verdict {
  if (score < 35) return 'safe';
  if (score < 70) return 'warn';
  return 'danger';
}

// ═══════════════ rules ═══════════════════════════════════════
export type RuleAction =
  | { type: 'placeOrder'; side: Side }
  | { type: 'modifyStop'; oldStop: number; newStop: number; side: Side; entry: number };

export function checkRules(state: AccountState, action: RuleAction): RuleViolation | null {
  const dailyReturnPct = (state.todayPnL / state.startOfDayEquity) * 100;

  // Rule 01 — Max Daily Loss
  if (dailyReturnPct <= -5) {
    return {
      rule: 'max_daily_loss',
      severity: 'hard_stop',
      message: `Daily loss limit reached (${dailyReturnPct.toFixed(2)}%). Trading locked until tomorrow.`,
    };
  }

  // Rule 02 — Max Daily Profit
  if (dailyReturnPct >= 100) {
    return {
      rule: 'max_daily_profit',
      severity: 'hard_stop',
      message: `Doubled today (+${dailyReturnPct.toFixed(0)}%). Locked. You won't give those gains back.`,
    };
  }

  // Rule 03 — Loss Cooldown
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    const hours = ((state.cooldownUntil - Date.now()) / 3_600_000).toFixed(1);
    return {
      rule: 'loss_cooldown',
      severity: 'auto_enforced',
      message: `Cooldown active. ${hours}h remaining. No revenge trades.`,
    };
  }

  if (action.type === 'placeOrder') {
    // Rule 05 — No Adding to Positions
    if (state.position && state.position.side === action.side) {
      return {
        rule: 'no_adding',
        severity: 'hard_stop',
        message: `Already ${action.side}. No pyramiding. Manage the trade you have.`,
      };
    }
  }

  if (action.type === 'modifyStop') {
    // Rule 04 — SL Discipline (no widening)
    const dir = action.side === 'long' ? 1 : -1;
    const oldDist = Math.abs(action.entry - action.oldStop);
    const newDist = Math.abs(action.entry - action.newStop);
    if (newDist > oldDist) {
      return {
        rule: 'sl_widen',
        severity: 'cancel_restore',
        message: `Stop widening blocked. Original stop @ ${action.oldStop.toFixed(2)} restored.`,
      };
    }
  }

  return null;
}

// ═══════════════ wallet ══════════════════════════════════════
export interface WalletAPI {
  connect(): Promise<string | null>;
  disconnect(): void;
  current(): string | null;
}

export function makeWallet(): WalletAPI {
  let address: string | null = null;
  return {
    async connect() {
      const eth = (window as any).ethereum;
      if (!eth) {
        // demo fallback so the UI still flows on a fresh laptop
        address = '0x' + Math.random().toString(16).slice(2, 10) + '…demo';
        return address;
      }
      const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
      address = accounts[0] || null;
      return address;
    },
    disconnect() { address = null; },
    current() { return address; },
  };
}

// ═══════════════ store ═══════════════════════════════════════
export type Listener<T> = (s: T) => void;

export class Store<T extends object> {
  private state: T;
  private listeners = new Set<Listener<T>>();
  constructor(initial: T) { this.state = initial; }
  get(): T { return this.state; }
  set(patch: Partial<T>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(l => l(this.state));
  }
  subscribe(l: Listener<T>): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

// ═══════════════ chart wrapper ═══════════════════════════════
// (See app.html for the running implementation — uses lightweight-charts
//  via CDN. The risk-zone shading is a CSS overlay positioned by
//  priceToCoordinate() to avoid fighting the charting lib's series API.)
