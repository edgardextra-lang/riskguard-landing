// ═══════════════════════════════════════════════════════════════
// HyperGuard — trading app (TypeScript source)
// Bundled by esbuild → dist/app.js. Loaded as ES module by app.html.
// ═══════════════════════════════════════════════════════════════

// ─── ambient: lightweight-charts loaded via CDN <script> in app.html ──
declare const LightweightCharts: any;
declare global {
  interface Window {
    ethereum?: any;
    switchCoin?: (coin: string) => Promise<void>;
    switchInterval?: (interval: string) => Promise<void>;
    ensureArbitrum?: () => Promise<boolean>;
    moveToBE?: () => void;
    tightenStop?: () => void;
    tryWidenStop?: () => void;
    closePos?: (reason: string) => void;
    setTP?: (price: number) => void;
    clearTP?: () => void;
  }
}

// ─── public types ───────────────────────────────────────────────
type Side = 'long' | 'short';
type Mode = 'conservative' | 'balanced' | 'aggressive';

interface ModeConfig {
  readonly maxLeverage: number;
  readonly maxRiskPct: number;
  readonly minLiqBufferPct: number;
  readonly label: string;
}
interface RiskInputs {
  equity: number;
  riskPct: number;
  stopPct: number;
  leverage: number;
  side: Side;
  markPrice: number;
}
interface RiskOutputs {
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
interface Position {
  coin?: string;
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
interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// ─── modes ────────────────────────────────────────────────────
const MODES: Record<Mode, ModeConfig> = {
  conservative: { maxLeverage: 3,  maxRiskPct: 1, minLiqBufferPct: 20, label: 'Conservative' },
  balanced:     { maxLeverage: 5,  maxRiskPct: 2, minLiqBufferPct: 15, label: 'Balanced' },
  aggressive:   { maxLeverage: 10, maxRiskPct: 5, minLiqBufferPct: 10, label: 'Aggressive' },
};

// ─── pure risk math ───────────────────────────────────────────
/** @param {RiskInputs} i @returns {RiskOutputs} */
//
// Standard perp sizing: notional = margin × leverage.
//   • "Risk per trade" slider = % of equity put up as margin.
//   • Sliding leverage visibly scales notional (matches every perp DEX).
//   • Stop-loss distance defines where the bot exits; max-loss-at-stop
//     is the ACTUAL dollars lost if stop fires (now leverage-dependent).
//   • Risk score now weights leverage + liq/stop ratio + max-loss-as-%-
//     of-equity. The harder you push leverage or the bigger the loss-
//     at-stop relative to your equity, the redder the score gets.
function computeRisk(i) {
  const dir = i.side === 'long' ? 1 : -1;
  const marginDollars = i.equity * (i.riskPct / 100);   // margin you're posting
  const notional      = marginDollars * i.leverage;     // leverage drives size
  const maxLossAtStop = notional * (i.stopPct / 100);   // real $ if stop hits
  const liqBufferPct  = (1 / i.leverage) * 100 * 0.95;  // ~maint margin
  const liqStopRatio  = liqBufferPct / i.stopPct;
  const entry = i.markPrice;
  const stopPrice = entry * (1 - dir * i.stopPct / 100);
  const liqPrice  = entry * (1 - dir * liqBufferPct / 100);

  const m = MODES[state.mode];
  const levScore     = Math.min(40, Math.pow(i.leverage / m.maxLeverage, 1.4) * 30);
  const ratioScore   = liqStopRatio < 1 ? 40 : liqStopRatio < 2 ? 25 : liqStopRatio < 3 ? 12 : 4;
  const maxLossPctEq = i.equity > 0 ? (maxLossAtStop / i.equity) * 100 : 0;
  // 5% loss-at-stop = mode-cap full. Anything over rapidly pushes score → danger.
  const lossScore    = Math.min(40, Math.pow(Math.max(0, maxLossPctEq) / 5, 1.2) * 22);
  const score = Math.max(0, Math.min(100, Math.round(levScore + ratioScore + lossScore)));

  return {
    notional,
    margin: marginDollars,
    liqPrice, stopPrice, liqBufferPct, liqStopRatio,
    riskScore: score,
    dollarRisk: maxLossAtStop,    // consumers (UI, post-trade modal) use this name
    entry,
  };
}

// ─── state ────────────────────────────────────────────────────
const state = {
  /** @type {Mode} */ mode: 'balanced',
  /** @type {Side} */ side: 'long',
  equity: 10000,
  startOfDayEquity: 10000,
  todayPnL: 0,
  /** @type {number|null} */ cooldownUntil: null,
  /** @type {Position|null} */ position: null,
  /** @type {string|null} */ walletAddress: null,
};
let lastClose = 62000;

// ─── rules engine ─────────────────────────────────────────────
/**
 * @param {{type:'placeOrder',side:Side}|{type:'modifyStop',oldStop:number,newStop:number,side:Side,entry:number}} action
 * @returns {{rule:string,severity:string,message:string}|null}
 */
function checkRules(action) {
  const dailyPct = (state.todayPnL / state.startOfDayEquity) * 100;

  if (dailyPct <= -5) {
    return { rule: 'max_daily_loss', severity: 'hard_stop',
      message: `Daily loss limit hit (${dailyPct.toFixed(2)}%). Trading locked until tomorrow.` };
  }
  if (dailyPct >= 100) {
    return { rule: 'max_daily_profit', severity: 'hard_stop',
      message: `Doubled today (+${dailyPct.toFixed(0)}%). Locked. You won't give those gains back.` };
  }
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    const hours = ((state.cooldownUntil - Date.now()) / 3_600_000).toFixed(1);
    return { rule: 'loss_cooldown', severity: 'auto_enforced',
      message: `Cooldown active. ${hours}h remaining. No revenge trades.` };
  }
  if (action.type === 'placeOrder' && state.position && state.position.side === action.side) {
    return { rule: 'no_adding', severity: 'hard_stop',
      message: `Already ${action.side}. No pyramiding. Manage the trade you have.` };
  }
  if (action.type === 'modifyStop') {
    const oldDist = Math.abs(action.entry - action.oldStop);
    const newDist = Math.abs(action.entry - action.newStop);
    if (newDist > oldDist) {
      return { rule: 'sl_widen', severity: 'cancel_restore',
        message: `Stop widening blocked. Original stop @ $${action.oldStop.toFixed(2)} restored.` };
    }
  }
  return null;
}

// ─── wallet (real EIP-1193 connect, no custody) ──────────────
//   • Detects window.ethereum (MetaMask, Rabby, Brave Wallet, Coinbase, ...)
//   • Auto-switches the wallet to Arbitrum One; adds it if unknown
//   • Persists to localStorage so refreshes don't drop the connection
//   • Listens for accountsChanged / chainChanged
//   • Silent restore on boot via eth_accounts (no popup)
//   • Pulls real HL account value from clearinghouseState after connect
const WALLET_KEY = 'hyperguard:wallet';

// Arbitrum One — chain ID 42161 (0xa4b1)
const ARBITRUM = {
  chainId: '0xa4b1',
  chainName: 'Arbitrum One',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://arb1.arbitrum.io/rpc'],
  blockExplorerUrls: ['https://arbiscan.io/'],
};

async function ensureArbitrum() {
  const eth = window.ethereum;
  if (!eth) return false;
  try {
    const current = await eth.request({ method: 'eth_chainId' });
    if ((current || '').toLowerCase() === ARBITRUM.chainId) return true;
  } catch {}
  try {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: ARBITRUM.chainId }],
    });
    return true;
  } catch (err) {
    // 4902 = unrecognized chain → try adding it
    if (err && (err.code === 4902 || /unrecognized|not.*added/i.test(err.message || ''))) {
      try {
        await eth.request({
          method: 'wallet_addEthereumChain',
          params: [ARBITRUM],
        });
        return true;
      } catch (addErr) {
        console.warn('[wallet] add Arbitrum rejected', addErr);
        return false;
      }
    }
    console.warn('[wallet] switch rejected', err);
    return false;
  }
}
window.ensureArbitrum = ensureArbitrum;

// Pull real HL account value (USD) for the connected wallet.
// Returns { accountValue, withdrawable, totalMarginUsed } or null on failure.
async function fetchHlAccount(addr) {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: addr }),
    });
    if (!res.ok) throw new Error(`HL clearinghouseState ${res.status}`);
    const data = await res.json();
    return {
      accountValue:    +(data?.marginSummary?.accountValue || 0),
      withdrawable:    +(data?.withdrawable || 0),
      totalMarginUsed: +(data?.marginSummary?.totalMarginUsed || 0),
    };
  } catch (e) {
    console.warn('[HyperGuard] fetchHlAccount failed:', e.message || e);
    return null;
  }
}
const wallet = {
  async connect() {
    const eth = window.ethereum;
    if (!eth) {
      const err = new Error('No wallet detected. Install MetaMask, Rabby, or another EIP-1193 wallet.');
      err.code = 'NO_PROVIDER';
      throw err;
    }
    const accs = await eth.request({ method: 'eth_requestAccounts' });
    const addr = (accs && accs[0]) || null;
    state.walletAddress = addr;
    if (addr) {
      try { localStorage.setItem(WALLET_KEY, addr); } catch {}
    }
    return addr;
  },
  async silentRestore() {
    const eth = window.ethereum;
    if (!eth) return null;
    try {
      const accs = await eth.request({ method: 'eth_accounts' });
      const addr = (accs && accs[0]) || null;
      if (addr) {
        state.walletAddress = addr;
        try { localStorage.setItem(WALLET_KEY, addr); } catch {}
      } else {
        try { localStorage.removeItem(WALLET_KEY); } catch {}
      }
      return addr;
    } catch { return null; }
  },
  disconnect() {
    state.walletAddress = null;
    try { localStorage.removeItem(WALLET_KEY); } catch {}
  },
  providerName() {
    const e = window.ethereum;
    if (!e) return null;
    if (e.isRabby) return 'Rabby';
    if (e.isMetaMask) return 'MetaMask';
    if (e.isCoinbaseWallet || e.isCoinbaseBrowser) return 'Coinbase';
    if (e.isBraveWallet) return 'Brave Wallet';
    return 'Wallet';
  },
};

async function applyConnectedUI(addr) {
  const btn = document.getElementById('walletBtn');
  if (!btn) return;
  // Idempotent — same address → no-op (avoids flicker on duplicate events)
  if (btn.dataset.connectedAddr === addr) return;
  btn.dataset.connectedAddr = addr;
  btn.classList.add('connected');
  btn.textContent = addr.length > 12 ? addr.slice(0, 6) + '…' + addr.slice(-4) : addr;
  document.getElementById('equityPill').style.display = '';
  document.getElementById('todayPill').style.display  = '';

  // Pull real HL account value — drives position sizing, the equity pill,
  // and today PnL math. Replaces the $10K demo baseline with the actual
  // wallet's deposited capital.
  const account = await fetchHlAccount(addr);
  if (account && account.accountValue > 0) {
    state.equity = account.accountValue;
    state.startOfDayEquity = account.accountValue;
    state.todayPnL = 0;
    document.getElementById('equity').textContent = fmt$(state.equity);
    document.getElementById('today-pnl').textContent = '+0.00%';
  } else {
    // Wallet has no HL deposit yet — show $0 and surface the gap clearly.
    state.equity = 0;
    state.startOfDayEquity = 0;
    state.todayPnL = 0;
    document.getElementById('equity').textContent = '$0.00';
    document.getElementById('today-pnl').textContent = '+0.00%';
    toast('No HL deposit detected — deposit USDC on Arbitrum to start trading', 'warn');
  }
  // recompute uses state.equity in the sizing formula → refresh the form
  recompute();
  pollRules();
}
function applyDisconnectedUI() {
  const btn = document.getElementById('walletBtn');
  if (!btn) return;
  delete btn.dataset.connectedAddr;
  btn.classList.remove('connected');
  // Refresh place button → "Connect wallet to trade"
  setTimeout(() => { try { pollRules(); } catch {} }, 0);
  btn.textContent = 'Connect wallet';
  document.getElementById('equityPill').style.display = 'none';
  document.getElementById('todayPill').style.display  = 'none';
}

// EIP-1193 event listeners — wallet is the source of truth, not local state
if (window.ethereum && typeof window.ethereum.on === 'function') {
  window.ethereum.on('accountsChanged', (accs) => {
    if (!accs || !accs.length) {
      wallet.disconnect();
      applyDisconnectedUI();
      toast('Wallet disconnected', 'warn');
    } else {
      // Skip if address didn't actually change — silent restore + a fresh
      // accountsChanged on connect can otherwise cascade twice.
      if (state.walletAddress === accs[0]) return;
      state.walletAddress = accs[0];
      try { localStorage.setItem(WALLET_KEY, accs[0]); } catch {}
      applyConnectedUI(accs[0]);
      toast('Account changed', 'ok');
    }
  });
  // Track chain — only reload on a *real* change. Some wallets emit
  // chainChanged on initial connect with the current chain, which would
  // trigger an infinite reload loop.
  let _lastChainId = null;
  window.ethereum.on('chainChanged', (chainId) => {
    if (_lastChainId != null && _lastChainId !== chainId) {
      location.reload();
    }
    _lastChainId = chainId;
  });
  // Seed the last chain id so the very first event isn't treated as a change
  try {
    window.ethereum.request({ method: 'eth_chainId' })
      .then((id) => { _lastChainId = id; })
      .catch(() => {});
  } catch {}
}

// ─── chart wrapper ────────────────────────────────────────────
const chartEl = document.getElementById('chart');
// Local-timezone formatters for the time scale + crosshair tooltip.
// Lightweight-charts treats incoming `time` as UTC seconds by default,
// so without these the axis ticks and crosshair both render in UTC.
// We resolve `time` → user's local zone via Intl APIs (uses the browser's
// resolved timezone — no manual offset needed).
const _tfHasSubday = () => /15m|1m|5m|30m|1h|2h|4h/.test(CURRENT_INTERVAL);
const _localDate = (t) => new Date(t * 1000);
const _tickMarkFormatter = (time, tickMarkType /*, locale */) => {
  const d = _localDate(time);
  // 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds
  switch (tickMarkType) {
    case 0: return d.toLocaleDateString(undefined, { year: 'numeric' });
    case 1: return d.toLocaleDateString(undefined, { month: 'short' });
    case 2: return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
    case 3: return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    case 4: return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  return d.toLocaleString();
};
const _crosshairTimeFormatter = (time) => {
  const d = _localDate(time);
  const subday = _tfHasSubday();
  return d.toLocaleString(undefined, subday
    ? { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: '2-digit' });
};

const chart = LightweightCharts.createChart(chartEl, {
  layout: { background: { color: '#07090c' }, textColor: '#6c7480', fontFamily: 'Geist Mono', fontSize: 11 },
  grid:   { vertLines: { color: '#11151c' }, horzLines: { color: '#11151c' } },
  rightPriceScale: { borderColor: '#1a2029' },
  timeScale: {
    borderColor: '#1a2029',
    timeVisible: true,
    secondsVisible: false,
    tickMarkFormatter: _tickMarkFormatter,
    // Reserve empty space on the right of the latest candle so the live
    // price action breathes away from the price axis. ~6 bars feels right
    // across all timeframes (15m / 4h / D / W).
    rightOffset: 6,
    barSpacing: 8,
    minBarSpacing: 2,
  },
  localization: {
    timeFormatter: _crosshairTimeFormatter,
  },
  crosshair: { mode: 1 },
  autoSize: true,
});
const candleSeries = chart.addCandlestickSeries({
  upColor: '#a3f7bf', downColor: '#ff7468',
  borderUpColor: '#a3f7bf', borderDownColor: '#ff7468',
  wickUpColor: '#a3f7bf', wickDownColor: '#ff7468',
});

// ─── BTC-PERP data from Hyperliquid (REST history + WS live stream) ───
const candles = [];
let liveSource = 'pending'; // 'hl' | 'fallback' | 'pending'

const HL_REST = 'https://api.hyperliquid.xyz/info';
const HL_WS   = 'wss://api.hyperliquid.xyz/ws';

// ─── Markets state ────────────────────────────────────────────
const marketsCache = { byCoin: /** @type {Record<string,any>} */ ({}) };
let currentCoin = 'BTC';

// Favorites — persisted to localStorage
const FAV_KEY = 'hyperguard:favorites';
function loadFavorites() {
  try {
    const f = JSON.parse(localStorage.getItem(FAV_KEY) || 'null');
    if (Array.isArray(f)) return new Set(f);
  } catch {}
  return new Set(['BTC', 'ETH', 'HYPE']); // sensible defaults
}
const favorites = loadFavorites();
function toggleFavorite(coin) {
  if (favorites.has(coin)) favorites.delete(coin);
  else favorites.add(coin);
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...favorites])); } catch {}
  renderDropdown();
}

// Per-coin visual identity for the icon + dropdown
const COIN_META = {
  BTC:  { sym: '₿', grad: 'linear-gradient(135deg,#f7931a,#ffb84a)', glow: 'rgba(247,147,26,.3)' },
  ETH:  { sym: 'Ξ', grad: 'linear-gradient(135deg,#627eea,#8da4f5)', glow: 'rgba(98,126,234,.3)' },
  HYPE: { sym: 'H', grad: 'linear-gradient(135deg,#19c2a4,#1ed3a3)', glow: 'rgba(25,194,164,.3)' },
  SOL:  { sym: 'S', grad: 'linear-gradient(135deg,#9945ff,#14f195)', glow: 'rgba(153,69,255,.3)' },
  ARB:  { sym: 'A', grad: 'linear-gradient(135deg,#28a0f0,#5cbef5)', glow: 'rgba(40,160,240,.3)' },
  AVAX: { sym: 'A', grad: 'linear-gradient(135deg,#e84142,#ff6b6c)', glow: 'rgba(232,65,66,.3)' },
};
function getCoinMeta(coin) {
  return COIN_META[coin] || { sym: coin[0] || '?', grad: 'linear-gradient(135deg,#6c7480,#aab2bd)', glow: 'rgba(108,116,128,.3)' };
}
function applyPairCoinUI() {
  const meta = getCoinMeta(currentCoin);
  const iEl = document.getElementById('pairCoinIcon');
  const nEl = document.getElementById('pairCoinName');
  if (iEl) {
    iEl.textContent = meta.sym;
    iEl.style.background = meta.grad;
    iEl.style.boxShadow = `0 0 0 1px ${meta.glow}`;
  }
  if (nEl) nEl.textContent = `${currentCoin}-USDC`;
}

function formatPx(p) {
  if (p == null || isNaN(p)) return '—';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (p >= 1)    return p.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (p >= 0.01) return p.toLocaleString('en-US', { maximumFractionDigits: 4, minimumFractionDigits: 4 });
  return p.toPrecision(4);
}
function formatUsdShort(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function fundingCountdown() {
  // HL settles funding hourly. Countdown = time until next top-of-hour UTC.
  const now = new Date();
  const ms = 3600_000 - (now.getUTCMinutes() * 60_000 + now.getUTCSeconds() * 1000 + now.getUTCMilliseconds());
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function fetchMetaAndCtxs() {
  const res = await fetch(HL_REST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  if (!res.ok) throw new Error(`metaAndAssetCtxs ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json) || json.length < 2) throw new Error('bad meta payload');
  const [meta, ctxs] = json;
  marketsCache.byCoin = {};
  meta.universe.forEach((u, i) => { marketsCache.byCoin[u.name] = ctxs[i]; });
  return { meta, ctxs };
}

// (markets ticker removed — favorites live in the dropdown now)
function renderTicker() { /* no-op, kept for compatibility */ }

// ─── Markets dropdown ─────────────────────────────────────────
function buildMarketRow(coin, ctx) {
  const px = +ctx.markPx;
  const prev = +ctx.prevDayPx;
  const pct = ((px - prev) / prev) * 100;
  const cls = pct >= 0 ? 'up' : 'down';
  const meta = getCoinMeta(coin);
  const active = coin === currentCoin ? 'active' : '';
  const isFav = favorites.has(coin);
  return `
    <div class="market-item ${active} ${isFav ? 'fav-row' : ''}" data-coin="${coin}">
      <span class="fav ${isFav ? 'on' : ''}" data-fav="${coin}" title="${isFav ? 'Unfavorite' : 'Favorite'}">${isFav ? '★' : '☆'}</span>
      <span class="micon" style="background:${meta.grad}">${meta.sym}</span>
      <span class="msym">${coin}-USDC</span>
      <span class="mpx">${formatPx(px)}</span>
      <span class="mpct ${cls}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>
    </div>
  `;
}

function renderDropdown() {
  const body = document.getElementById('ddBody');
  if (!body) return;
  const filterRaw = (document.getElementById('ddSearch').value || '').trim().toUpperCase();
  const all = Object.keys(marketsCache.byCoin)
    .filter(c => !filterRaw || c.includes(filterRaw))
    .map(c => ({ coin: c, ctx: marketsCache.byCoin[c] }));

  const favs = all
    .filter(({ coin }) => favorites.has(coin))
    .sort((a, b) => +b.ctx.dayNtlVlm - +a.ctx.dayNtlVlm);
  const others = all
    .filter(({ coin }) => !favorites.has(coin))
    .sort((a, b) => +b.ctx.dayNtlVlm - +a.ctx.dayNtlVlm)
    .slice(0, 80);

  let html = '';
  if (favs.length) {
    html += `<div class="markets-dd-section">★ Favorites</div>`;
    html += favs.map(({ coin, ctx }) => buildMarketRow(coin, ctx)).join('');
    html += `<div class="markets-dd-section">All markets</div>`;
  }
  html += others.map(({ coin, ctx }) => buildMarketRow(coin, ctx)).join('');
  body.innerHTML = html || `<div style="padding:32px 16px;text-align:center;color:var(--text-3);font-family:var(--f-mono);font-size:11px;">No matches</div>`;

  body.querySelectorAll('.fav').forEach(s => {
    s.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(s.dataset.fav);
    });
  });
  body.querySelectorAll('.market-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.fav')) return;
      switchCoin(el.dataset.coin);
      closeDropdown();
    });
  });
}
function positionDropdown() {
  const dd = document.getElementById('marketsDd');
  const pc = document.getElementById('pairCoin');
  if (!dd || !pc) return;
  const r = pc.getBoundingClientRect();
  // Anchor under the trigger, left-aligned. Clamp to viewport on the right.
  const ddWidth = 380;
  let left = r.left;
  if (left + ddWidth > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - ddWidth - 8);
  }
  dd.style.top  = (r.bottom + 6) + 'px';
  dd.style.left = left + 'px';
}
function openDropdown() {
  const dd = document.getElementById('marketsDd');
  const pc = document.getElementById('pairCoin');
  if (!dd || !pc) return;
  renderDropdown();
  positionDropdown();
  dd.classList.add('open');
  pc.classList.add('open');
  setTimeout(() => document.getElementById('ddSearch').focus(), 50);
}
window.addEventListener('resize', () => {
  if (document.getElementById('marketsDd')?.classList.contains('open')) positionDropdown();
});
window.addEventListener('scroll', () => {
  if (document.getElementById('marketsDd')?.classList.contains('open')) positionDropdown();
}, true);
function closeDropdown() {
  document.getElementById('marketsDd')?.classList.remove('open');
  document.getElementById('pairCoin')?.classList.remove('open');
}

function renderPairBar() {
  const ctx = marketsCache.byCoin[currentCoin];
  if (!ctx) return;
  const mark = +ctx.markPx;
  const oracle = +ctx.oraclePx;
  const prev = +ctx.prevDayPx;
  const delta = mark - prev;
  const pct = (delta / prev) * 100;
  const vol = +ctx.dayNtlVlm;
  // openInterest is in base units (BTC) — convert to USD
  const oiUsd = +ctx.openInterest * mark;
  const fundingPct = (+ctx.funding) * 100; // hourly funding rate, as %

  // Mark cell is driven by live WS in updatePriceUI(); seed it on first paint
  const m = document.getElementById('ps-mark');
  if (m && (!m.textContent || m.textContent === '—')) m.textContent = formatPx(mark);

  document.getElementById('ps-oracle').textContent = formatPx(oracle);

  const cEl = document.getElementById('ps-change');
  if (cEl && cEl.children.length === 2) {
    // Patch persistent children — was rebuilding innerHTML which
    // destroys/recreates the inner spans on every paint → flicker.
    cEl.children[0].textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} `;
    cEl.children[1].textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    const cls = pct >= 0 ? 'up' : 'down';
    if (cEl._lastCls !== cls) { cEl.className = 'v ' + cls; cEl._lastCls = cls; }
  }

  document.getElementById('ps-vol').textContent = formatUsdShort(vol);
  document.getElementById('ps-oi').textContent  = formatUsdShort(oiUsd);

  const fEl = document.getElementById('ps-funding');
  if (fEl && fEl.children.length === 2) {
    fEl.children[0].textContent = `${fundingPct >= 0 ? '+' : ''}${fundingPct.toFixed(4)}%`;
    fEl.children[1].textContent = ` / ${fundingCountdown()}`;
    const cls = fundingPct >= 0 ? 'up' : 'down';
    if (fEl.children[0]._cls !== cls) {
      fEl.children[0].className = cls;
      fEl.children[0]._cls = cls;
    }
  }
}

async function pollMarkets() {
  try {
    await fetchMetaAndCtxs();
    renderTicker();
    renderPairBar();
  } catch (e) {
    console.warn('[HyperGuard] markets feed:', e.message || e);
  }
}
// initial fetch + 5s poll
pollMarkets();
setInterval(pollMarkets, 5000);
// funding countdown ticks every second using cached ctx
setInterval(() => {
  const ctx = marketsCache.byCoin[currentCoin];
  if (!ctx) return;
  const fEl = document.getElementById('ps-funding');
  if (!fEl || fEl.children.length !== 2) return;
  const fundingPct = (+ctx.funding) * 100;
  // Patch only the countdown text — the rate didn't change at 1Hz.
  // (Was rebuilding innerHTML every second → DOM thrash → flicker.)
  fEl.children[0].textContent = `${fundingPct >= 0 ? '+' : ''}${fundingPct.toFixed(4)}%`;
  fEl.children[1].textContent = ` / ${fundingCountdown()}`;
  const cls = fundingPct >= 0 ? 'up' : 'down';
  if (fEl.children[0]._cls !== cls) {
    fEl.children[0].className = cls;
    fEl.children[0]._cls = cls;
  }
}, 1000);

// default timeframe — 15m bars, 200 of them = ~50 hours of context
const INTERVAL_SECONDS_BY_KEY = { '15m': 15 * 60, '4h': 4 * 3600, '1d': 86400, '1w': 7 * 86400 };
let CURRENT_INTERVAL = '15m';
let INTERVAL_SECONDS = INTERVAL_SECONDS_BY_KEY[CURRENT_INTERVAL];

async function switchInterval(newInterval) {
  if (!INTERVAL_SECONDS_BY_KEY[newInterval]) return;
  if (newInterval === CURRENT_INTERVAL) return;
  CURRENT_INTERVAL = newInterval;
  INTERVAL_SECONDS = INTERVAL_SECONDS_BY_KEY[newInterval];
  // refresh active button states
  document.querySelectorAll('.tf-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tf === newInterval);
  });
  try {
    await loadHyperliquidHistory(currentCoin);
    openHyperliquidStream(currentCoin);
    liveSource = 'hl';
  } catch (e) {
    console.warn('[HyperGuard] switchInterval failed', e);
    seedSynthetic();
  }
  // Re-apply right-side padding — fitContent / setData can collapse it,
  // and on D/W the bar count is small so the chart auto-fits flush.
  try { chart.timeScale().applyOptions({ rightOffset: 6, barSpacing: 8 }); } catch {}
  recompute();
}
window.switchInterval = switchInterval;

async function loadHyperliquidHistory(coin = currentCoin) {
  const endTime = Date.now();
  const startTime = endTime - 200 * INTERVAL_SECONDS * 1000;
  const res = await fetch(HL_REST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'candleSnapshot',
      req: { coin, interval: CURRENT_INTERVAL, startTime, endTime },
    }),
  });
  if (!res.ok) throw new Error(`HL REST ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) throw new Error('empty candle response');
  candles.length = 0;
  for (const c of data) {
    candles.push({
      time: Math.floor(c.t / 1000),
      open:  +c.o, high: +c.h, low: +c.l, close: +c.c,
    });
  }
  candles.sort((a, b) => a.time - b.time);
  for (let k = candles.length - 1; k > 0; k--) {
    if (candles[k].time === candles[k - 1].time) candles.splice(k, 1);
  }
  lastClose = candles[candles.length - 1].close;
  candleSeries.setData(candles);
  // Preserve right-side breathing room — setData can collapse rightOffset
  try { chart.timeScale().applyOptions({ rightOffset: 6, barSpacing: 8 }); } catch {}
}

let _ws = null;
let _wsRetry = 0;
let _wsCoin = null;
function openHyperliquidStream(coin = currentCoin) {
  try { _ws && _ws.close(); } catch {}
  const ws = new WebSocket(HL_WS);
  _ws = ws;
  _wsCoin = coin;
  ws.onopen = () => {
    _wsRetry = 0;
    // 1m candles drive chart bars
    ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'candle', coin, interval: CURRENT_INTERVAL },
    }));
    // trades drive sub-second mark price (faster than candle ticks)
    ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'trades', coin },
    }));
    liveSource = 'hl';
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    // ── candle channel ──
    if (msg.channel === 'candle' && msg.data && coin === _wsCoin) {
      const c = msg.data;
      // gate by coin so a stale subscription doesn't bleed into a switched view
      if (c.s && c.s !== _wsCoin) return;
      const tSec = Math.floor(c.t / 1000);
      const candle = { time: tSec, open: +c.o, high: +c.h, low: +c.l, close: +c.c };
      const last = candles[candles.length - 1];
      if (last && last.time === tSec) {
        candles[candles.length - 1] = candle;
      } else if (!last || tSec > last.time) {
        candles.push(candle);
      } else {
        return;
      }
      candleSeries.update(candle);
      lastClose = candle.close;
      updatePriceUI();
      if (state.position) updatePositionUI();
      recompute();
    }
    // ── trades channel — sub-second mark updates ──
    else if (msg.channel === 'trades' && Array.isArray(msg.data)) {
      const trades = msg.data;
      if (!trades.length) return;
      const t = trades[trades.length - 1];
      if (t.coin && t.coin !== _wsCoin) return;
      const px = +t.px;
      if (!isFinite(px)) return;
      lastClose = px;
      // patch the in-progress candle so the chart reacts
      const last = candles[candles.length - 1];
      if (last) {
        last.close = px;
        if (px > last.high) last.high = px;
        if (px < last.low)  last.low  = px;
        candleSeries.update(last);
      }
      updatePriceUI();
      if (state.position) updatePositionUI();
      recompute();
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    _wsRetry = Math.min(_wsRetry + 1, 6);
    const delay = Math.min(30_000, 1000 * 2 ** _wsRetry);
    setTimeout(() => openHyperliquidStream(_wsCoin || currentCoin), delay);
  };
}

// ─── Switch market ────────────────────────────────────────────
async function switchCoin(newCoin) {
  if (!newCoin || newCoin === currentCoin) { closeDropdown(); return; }
  if (state.position) {
    toast('Close current position before switching markets', 'warn');
    closeDropdown();
    return;
  }
  currentCoin = newCoin;
  applyPairCoinUI();
  renderTicker();
  // immediately pull fresh history + restart stream
  try {
    await loadHyperliquidHistory(currentCoin);
    openHyperliquidStream(currentCoin);
    liveSource = 'hl';
    toast(`Switched to ${currentCoin}-USDC`, 'ok');
  } catch (e) {
    console.warn('[HyperGuard] switchCoin failed', e);
    seedSynthetic();
  }
  renderPairBar();
  recompute();
}
window.switchCoin = switchCoin;

// fallback: synthetic walk if HL is unreachable (CORS / offline / dev)
function seedSynthetic() {
  candles.length = 0;
  lastClose = 62000;
  const now = Math.floor(Date.now() / 1000);
  for (let k = 0; k < 200; k++) {
    const t = now - (200 - k) * INTERVAL_SECONDS;
    const drift = (Math.random() - 0.5) * 0.0035;   // 15m bars get bigger drift
    const open = lastClose;
    const close = open * (1 + drift);
    const hi = Math.max(open, close) * (1 + Math.random() * 0.0015);
    const lo = Math.min(open, close) * (1 - Math.random() * 0.0015);
    candles.push({ time: t, open, high: hi, low: lo, close });
    lastClose = close;
  }
  candleSeries.setData(candles);
  // Preserve right-side breathing room — setData can collapse rightOffset
  try { chart.timeScale().applyOptions({ rightOffset: 6, barSpacing: 8 }); } catch {}
  liveSource = 'fallback';
}
function syntheticTick() {
  if (liveSource !== 'fallback') return;
  const last = candles[candles.length - 1];
  const drift = (Math.random() - 0.5) * 0.0012;
  const newClose = last.close * (1 + drift);
  const updated = {
    time: last.time,
    open: last.open,
    high: Math.max(last.high, newClose),
    low:  Math.min(last.low, newClose),
    close: newClose,
  };
  candles[candles.length - 1] = updated;
  candleSeries.update(updated);
  lastClose = newClose;
  const t = Math.floor(Date.now() / 1000);
  if (t - last.time >= INTERVAL_SECONDS) {
    const c = { time: last.time + INTERVAL_SECONDS, open: newClose, high: newClose, low: newClose, close: newClose };
    candles.push(c);
    candleSeries.update(c);
  }
  updatePriceUI();
  if (state.position) updatePositionUI();
  recompute();
  pollRules();
}

(async function bootData() {
  try {
    await loadHyperliquidHistory();
    openHyperliquidStream();
    console.info('[HyperGuard] BTC-PERP feed: Hyperliquid live');
  } catch (err) {
    console.warn('[HyperGuard] Hyperliquid feed unavailable, using synthetic walk:', err.message || err);
    seedSynthetic();
  }
})();

// price lines
let entryLine = null, stopLine = null, liqLine = null;
let tpLine = null, tpPrice = null;
let _prevRiskBand = 'safe';   // tracks band changes for escalation animations
function clearLines() {
  if (entryLine) candleSeries.removePriceLine(entryLine);
  if (stopLine)  candleSeries.removePriceLine(stopLine);
  if (liqLine)   candleSeries.removePriceLine(liqLine);
  entryLine = stopLine = liqLine = null;
  clearTP();
}
function clearTP() {
  if (tpLine) { try { candleSeries.removePriceLine(tpLine); } catch {} }
  tpLine = null;
  tpPrice = null;
  if (state.position) renderPosCard();
}
window.clearTP = clearTP;
function setTP(price) {
  if (!state.position) return;
  if (!isFinite(price)) return;
  tpPrice = price;
  const p = state.position;
  const dir = p.side === 'long' ? 1 : -1;
  const movePct = ((price - p.entry) * dir / p.entry) * 100;
  const pnlUsd  = (movePct / 100) * p.notional;
  const color = pnlUsd >= 0 ? '#a3f7bf' : '#ff7468';
  const sign = pnlUsd >= 0 ? '+' : '−';
  const title = `TP  ${sign}$${Math.abs(pnlUsd).toFixed(2)}  ${pnlUsd >= 0 ? '+' : ''}${movePct.toFixed(2)}%`;
  // In-place update — same flicker fix as drawLines
  if (tpLine) {
    tpLine.applyOptions({ price, color, title });
  } else {
    tpLine = candleSeries.createPriceLine({
      price, color, lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Dotted,
      axisLabelVisible: true,
      title,
    });
  }
  renderPosCard();
}
window.setTP = setTP;
function refreshTPLabel() {
  if (!tpLine || !state.position || tpPrice == null) return;
  const p = state.position;
  const dir = p.side === 'long' ? 1 : -1;
  const movePct = ((tpPrice - p.entry) * dir / p.entry) * 100;
  const pnlUsd  = (movePct / 100) * p.notional;
  const sign = pnlUsd >= 0 ? '+' : '−';
  try {
    tpLine.applyOptions({
      title: `TP  ${sign}$${Math.abs(pnlUsd).toFixed(2)}  ${pnlUsd >= 0 ? '+' : ''}${movePct.toFixed(2)}%`,
      color: pnlUsd >= 0 ? '#a3f7bf' : '#ff7468',
    });
  } catch {}
}

// ── Chart interaction layer: hover hint + drag TP + click-to-set-TP ──
//   While in a position:
//     • hovering the chart shows a cursor-following hint with the live
//       $/% TP would represent at the cursor's price
//     • clicking sets the TP at that price
//     • clicking-and-dragging the existing TP line moves it; the hint and
//       position card update in real time
//   Click-vs-drag detection keeps native chart pan (5px / 400ms threshold).
{
  const tipEl = document.getElementById('chartTip');
  let _md = null;          // mousedown info for click-vs-drag
  let _dragMode = null;    // null | 'tp' (dragging existing TP line)

  function priceFromEvent(e) {
    const rect = chartEl.getBoundingClientRect();
    const y = e.clientY - rect.top;
    return { y, px: candleSeries.coordinateToPrice(y), x: e.clientX - rect.left };
  }
  function tpYNear(y) {
    if (tpPrice == null) return false;
    const tpY = candleSeries.priceToCoordinate(tpPrice);
    return tpY != null && Math.abs(y - tpY) <= 8;
  }
  function pnlAt(price) {
    const p = state.position; if (!p) return null;
    const dir = p.side === 'long' ? 1 : -1;
    const movePct = ((price - p.entry) * dir / p.entry) * 100;
    const pnlUsd = (movePct / 100) * p.notional;
    return { movePct, pnlUsd };
  }
  function paintTip(x, y, price, dragging) {
    if (!state.position || price == null) { tipEl.classList.remove('show'); return; }
    const { movePct, pnlUsd } = pnlAt(price) || {};
    const cls = pnlUsd >= 0 ? 'up' : 'down';
    const sign = pnlUsd >= 0 ? '+' : '−';
    const action = dragging ? 'Drag TP →' : (tpPrice != null ? 'Click to move TP' : 'Click to set TP');
    tipEl.innerHTML = `
      <span class="lbl">${action}</span>
      <span class="px">$${formatPx(price)}</span>
      <span class="pnl ${cls}">${sign}$${Math.abs(pnlUsd).toFixed(2)} ${pnlUsd >= 0 ? '+' : ''}${movePct.toFixed(2)}%</span>
    `;
    tipEl.classList.toggle('dragging', !!dragging);
    // Position next to cursor with viewport clamping inside chart
    const rect = chartEl.getBoundingClientRect();
    const tipW = tipEl.offsetWidth || 240;
    const tipH = tipEl.offsetHeight || 28;
    let nx = x + 14, ny = y + 14;
    if (nx + tipW > rect.width - 8)  nx = x - tipW - 14;
    if (ny + tipH > rect.height - 8) ny = y - tipH - 14;
    tipEl.style.left = nx + 'px';
    tipEl.style.top  = ny + 'px';
    tipEl.classList.add('show');
  }

  chartEl.addEventListener('mousemove', (e) => {
    if (!state.position) { tipEl.classList.remove('show'); chartEl.style.cursor = ''; return; }
    if (e.target.closest('.legend, .chart-ohlc, .risk-zone, .chart-tip')) {
      tipEl.classList.remove('show');
      return;
    }
    const { y, px, x } = priceFromEvent(e);
    if (px == null) { tipEl.classList.remove('show'); return; }
    if (_dragMode === 'tp') {
      // Delegate to setTP — applyOptions in place, no DOM thrash
      setTP(px);
      paintTip(x, y, px, true);
      chartEl.style.cursor = 'grabbing';
      return;
    }
    paintTip(x, y, px, false);
    chartEl.style.cursor = tpYNear(y) ? 'grab' : 'crosshair';
  });
  chartEl.addEventListener('mouseleave', () => {
    if (_dragMode) return;
    tipEl.classList.remove('show');
    chartEl.style.cursor = '';
  });

  chartEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.legend, .chart-ohlc, .risk-zone, .chart-tip')) return;
    if (!state.position) return;
    const { y } = priceFromEvent(e);
    if (tpYNear(y)) {
      _dragMode = 'tp';
      e.preventDefault();
      return;
    }
    _md = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  // mouseup must be on window so a drag that ends outside the chart still resolves
  window.addEventListener('mouseup', (e) => {
    if (_dragMode === 'tp') {
      _dragMode = null;
      chartEl.style.cursor = '';
      toast('Take profit moved', 'ok');
      return;
    }
    if (!_md) return;
    const dx = Math.abs(e.clientX - _md.x);
    const dy = Math.abs(e.clientY - _md.y);
    const dt = Date.now() - _md.t;
    _md = null;
    if (dx > 5 || dy > 5 || dt > 400) return;          // was a chart pan
    if (e.target.closest('.legend, .chart-ohlc, .risk-zone, .chart-tip')) return;
    if (!state.position) return;
    const rect = chartEl.getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (y < 0 || y > rect.height) return;
    const px = candleSeries.coordinateToPrice(y);
    if (px == null) return;
    setTP(px);
    toast('Take profit set — drag the line to move, ✕ in card to clear', 'ok');
  });
}
function drawLines(entry, stop, liq) {
  // In-place price updates — was destroying + recreating the three
  // PriceLine objects via removePriceLine/createPriceLine on every
  // WS tick. At real-BTC trade rates (10-20+/sec), the right-axis
  // labels (ENTRY/STOP/LIQ badges) flickered visibly. applyOptions
  // mutates the existing line — no DOM thrash.
  if (entryLine) entryLine.applyOptions({ price: entry });
  else entryLine = candleSeries.createPriceLine({
    price: entry, color: '#a3f7bf', lineWidth: 2,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    axisLabelVisible: true, title: 'ENTRY',
  });
  if (stopLine) stopLine.applyOptions({ price: stop });
  else stopLine = candleSeries.createPriceLine({
    price: stop, color: '#ffce6b', lineWidth: 2,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    axisLabelVisible: true, title: 'STOP',
  });
  if (liqLine) liqLine.applyOptions({ price: liq });
  else liqLine = candleSeries.createPriceLine({
    price: liq, color: '#ff7468', lineWidth: 2,
    lineStyle: LightweightCharts.LineStyle.Solid,
    axisLabelVisible: true, title: 'LIQ',
  });
}

// risk-zone overlay (CSS box positioned via priceToCoordinate)
const zoneEl = document.getElementById('riskZone');
function paintRiskZone(stopPrice, liqPrice) {
  const yStop = candleSeries.priceToCoordinate(stopPrice);
  const yLiq  = candleSeries.priceToCoordinate(liqPrice);
  if (yStop == null || yLiq == null) {
    zoneEl.style.opacity = '0';
    return;
  }
  // Clamp to chart bounds — when the liq is far below visible price range,
  // priceToCoordinate returns a value past the chart's height and the zone
  // bleeds into whatever sits below the chart (e.g. position card).
  const chartH = chartEl.clientHeight;
  let top = Math.min(yStop, yLiq);
  let bot = Math.max(yStop, yLiq);
  top = Math.max(0, Math.min(chartH, top));
  bot = Math.max(0, Math.min(chartH, bot));
  if (bot - top < 1) {
    zoneEl.style.opacity = '0';
    return;
  }
  zoneEl.style.top    = top + 'px';
  zoneEl.style.height = (bot - top) + 'px';
  zoneEl.style.opacity = state.position ? '1' : '0.85';
}

// ─── tick driver ──────────────────────────────────────────────
// Live HL feed pushes via WS. Fallback synthetic walk runs only
// when the HL handshake fails. Either way: rule polling fires on
// every UI refresh — rules eval is cheap, so we co-locate it.
setInterval(() => {
  if (liveSource === 'fallback') syntheticTick();
  else { /* HL WS drives renders; keep rules ticking */ pollRules(); }
}, 800);

// ── OHLC strip ─────────────────────────────────────────────────
function updateOhlc(bar) {
  if (!bar) return;
  const o = +bar.open, h = +bar.high, l = +bar.low, c = +bar.close;
  const $o = document.getElementById('oh-o'); if ($o) $o.textContent = formatPx(o);
  const $h = document.getElementById('oh-h'); if ($h) $h.textContent = formatPx(h);
  const $l = document.getElementById('oh-l'); if ($l) $l.textContent = formatPx(l);
  const $c = document.getElementById('oh-c'); if ($c) $c.textContent = formatPx(c);
  const $d = document.getElementById('oh-d');
  if ($d) {
    const delta = c - o;
    const pct = o ? (delta / o) * 100 : 0;
    const sign = delta >= 0 ? '+' : '−';
    $d.textContent = `${sign}${formatPx(Math.abs(delta))} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
    $d.className = 'delta ' + (delta >= 0 ? 'up' : 'down');
  }
}
chart.subscribeCrosshairMove((param) => {
  let bar = null;
  if (param && param.time && param.seriesData && param.seriesData.size) {
    bar = param.seriesData.get(candleSeries);
  }
  if (!bar) bar = candles[candles.length - 1];
  updateOhlc(bar);
});

function updatePriceUI() {
  // OHLC tracks the latest candle when not hovering
  if (candles.length) updateOhlc(candles[candles.length - 1]);

  // Mark = live last close (drives chart + risk math)
  const m = document.getElementById('ps-mark');
  if (m) m.textContent = formatPx(lastClose);

  // 24h Change uses prevDayPx from cached HL ctx for the *current* coin
  // (was hard-coded to 'BTC'), falling back to the first loaded candle.
  // candles[] is empty until HL history resolves, so guard the fallback.
  const ctx = marketsCache.byCoin[currentCoin];
  const prev = (ctx && +ctx.prevDayPx) || (candles.length ? candles[0].close : lastClose);
  if (!prev || !isFinite(prev) || !isFinite(lastClose)) return;
  const delta = lastClose - prev;
  const pct = (delta / prev) * 100;
  const cEl = document.getElementById('ps-change');
  if (cEl && cEl.children.length === 2) {
    // Hot path — runs on every WS trade tick. Patch persistent children
    // via textContent instead of innerHTML rebuild (was the flicker
    // source for the 24h-change cell).
    cEl.children[0].textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} `;
    cEl.children[1].textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    const cls = pct >= 0 ? 'up' : 'down';
    if (cEl._lastCls !== cls) { cEl.className = 'v ' + cls; cEl._lastCls = cls; }
  }
}

// ─── DOM helpers ──────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const fmt$ = (n) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmt0 = (n) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });

function clampInputs() {
  const m = MODES[state.mode];
  $('i-lev').max  = m.maxLeverage;
  $('i-risk').max = m.maxRiskPct;
  if (+$('i-lev').value  > m.maxLeverage) $('i-lev').value  = m.maxLeverage;
  if (+$('i-risk').value > m.maxRiskPct)  $('i-risk').value = m.maxRiskPct;
  $('levHint').textContent  = `cap ${m.maxLeverage}×`;
  $('riskHint').textContent = `${m.maxRiskPct}% max · ${m.label}`;
}

// ─── recompute (the heart of the UI) ──────────────────────────
function recompute() {
  const inputs = {
    equity: state.equity,
    riskPct: +$('i-risk').value,
    stopPct: +$('i-stop').value,
    leverage: +$('i-lev').value,
    side: state.side,
    markPrice: lastClose,
  };
  $('i-risk-v').textContent = inputs.riskPct;
  $('i-stop-v').textContent = inputs.stopPct;
  $('i-lev-v').textContent  = inputs.leverage;

  const r = computeRisk(inputs);

  $('i-size').textContent = fmt0(r.notional);
  $('riskScore').textContent = r.riskScore;

  // risk badge color
  const color = r.riskScore < 35 ? '#a3f7bf' : r.riskScore < 70 ? '#ffce6b' : '#ff7468';
  $('rdot').style.background = color;
  $('rdot').style.boxShadow = `0 0 8px ${color}`;
  $('riskBadge').style.borderColor = color;
  $('riskScore').style.color = color;

  // Risk-band escalation animations — fire when crossing into a riskier band.
  // Body classes drive slider thumb glow; badge flash + zone flash give a
  // tactile "you just made this more dangerous" cue without being noisy.
  const newBand = r.riskScore < 35 ? 'safe' : r.riskScore < 70 ? 'warn' : 'danger';
  if (newBand !== _prevRiskBand) {
    const escalating = (
      (_prevRiskBand === 'safe' && newBand !== 'safe') ||
      (_prevRiskBand === 'warn' && newBand === 'danger')
    );
    document.body.classList.toggle('risk-warn',   newBand === 'warn');
    document.body.classList.toggle('risk-danger', newBand === 'danger');
    if (escalating) {
      const badge = $('riskBadge');
      const zone  = $('riskZone');
      badge.classList.remove('flash-warn', 'flash-danger');
      zone.classList.remove('flash');
      // Force reflow so re-adding the same class restarts the animation
      void badge.offsetWidth; void zone.offsetWidth;
      badge.classList.add(newBand === 'danger' ? 'flash-danger' : 'flash-warn');
      zone.classList.add('flash');
    }
    _prevRiskBand = newBand;
  }

  // legend

  // chart lines + zone (only when no live position)
  if (!state.position) {
    drawLines(r.entry, r.stopPrice, r.liqPrice);
    paintRiskZone(r.stopPrice, r.liqPrice);
  }

  // refresh probe (depends on current sizing)
  updateProbe(r);

  return r;
}

// ─── "What kills me?" probe ───────────────────────────────────
function updateProbe(r) {
  const probePct = +$('probe').value;     // -15 → +15 % vs mark
  const probePrice = r.entry * (1 + probePct / 100);
  const dir = state.side === 'long' ? 1 : -1;
  const moveSignedPct = ((probePrice - r.entry) / r.entry) * 100 * dir;
  const pnlUsd = (moveSignedPct / 100) * r.notional;

  // outcome
  const liqHit = dir === 1 ? probePrice <= r.liqPrice : probePrice >= r.liqPrice;
  const stopHit = dir === 1 ? probePrice <= r.stopPrice : probePrice >= r.stopPrice;

  $('probe-price').textContent = '$' + probePrice.toLocaleString('en-US', { maximumFractionDigits: 1 });
  const pnlEl = $('probe-pnl');
  pnlEl.textContent = (pnlUsd >= 0 ? '+' : '') + fmt$(pnlUsd);
  pnlEl.className = 'v ' + (pnlUsd >= 0 ? 'up' : 'down');

  const out = $('probe-out');
  const stEl = $('probe-state');
  if (liqHit) {
    out.textContent = '☠ Liquidated';
    out.className = 'v down';
    stEl.textContent = 'LIQUIDATED';
    stEl.className = 'probe-state dead';
  } else if (stopHit) {
    out.textContent = `Stopped at ${fmt$(-r.dollarRisk)}`;
    out.className = 'v down';
    stEl.textContent = 'STOP HIT';
    stEl.className = 'probe-state stop';
  } else {
    out.textContent = pnlUsd >= 0 ? 'Position alive' : 'Underwater, in budget';
    out.className = 'v ' + (pnlUsd >= 0 ? 'up' : '');
    stEl.textContent = 'ALIVE';
    stEl.className = 'probe-state ok';
  }
}

// ─── rules HUD updater ────────────────────────────────────────
function pollRules() {
  const dailyPct = (state.todayPnL / state.startOfDayEquity) * 100;

  // Rule 1
  const r1 = $('rh-1');
  r1.classList.toggle('tripped', dailyPct <= -5);
  r1.classList.toggle('ok',     dailyPct >  -5);
  r1.querySelector('.rv').textContent = `${dailyPct.toFixed(2)}% / −5%`;

  // Rule 2
  const r2 = $('rh-2');
  r2.classList.toggle('tripped', dailyPct >= 100);
  r2.classList.toggle('ok',     dailyPct <  100);
  r2.querySelector('.rv').textContent = `${dailyPct >= 0 ? '+' : ''}${dailyPct.toFixed(2)}% / +100%`;

  // Rule 3
  const r3 = $('rh-3');
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    r3.classList.remove('ok'); r3.classList.add('tripped');
    const h = ((state.cooldownUntil - Date.now()) / 3_600_000).toFixed(1);
    r3.querySelector('.rv').textContent = `${h}h left`;
  } else {
    r3.classList.add('ok'); r3.classList.remove('tripped');
    r3.querySelector('.rv').textContent = '— inactive';
  }

  // Rule 5 — adding blocked iff a position exists in current direction
  const r5 = $('rh-5');
  if (state.position) {
    r5.querySelector('.rv').textContent = `${state.position.side} held`;
  } else {
    r5.querySelector('.rv').textContent = 'enforced';
  }

  // gate the place button if any rule blocks a new order
  const violation = checkRules({ type: 'placeOrder', side: state.side });
  const banner = $('blocked');
  const placeBtn = $('placeBtn');
  if (violation) {
    placeBtn.disabled = true;
    placeBtn.textContent = 'Blocked · ' + violation.rule.replace(/_/g, ' ');
    banner.classList.add('show');
    $('blocked-rule').textContent = violation.rule.replace(/_/g, ' ');
    $('blocked-msg').textContent = violation.message;
  } else {
    if (!state.walletAddress) {
      placeBtn.disabled = true;
      placeBtn.textContent = 'Connect wallet to trade';
      placeBtn.className = 'place-btn';
    } else {
      placeBtn.disabled = !!state.position;
      placeBtn.textContent = state.position ? 'Close current first' : `Place ${state.side}`;
      placeBtn.className = 'place-btn ' + state.side;
    }
    banner.classList.remove('show');
  }

  // ── Update the sub-header rules badge (aggregate state) ──
  const badge = document.getElementById('rulesBadge');
  const count = document.getElementById('rulesBadgeCount');
  if (badge && count) {
    const tripped = document.querySelectorAll('.rule-line.tripped').length;
    badge.classList.toggle('tripped', tripped > 0);
    count.textContent = tripped > 0 ? `${tripped} TRIPPED` : `5/5 OK`;
  }
}

// ─── side / mode bindings ─────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.mode = b.dataset.mode;
    clampInputs();
    recompute();
  });
});
document.querySelectorAll('.side-tab').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.side-tab').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.side = b.dataset.side;
    pollRules();
    recompute();
  });
});
['i-risk', 'i-stop', 'i-lev', 'probe'].forEach(id => $(id).addEventListener('input', () => {
  const r = recompute();
  // Defensive: ensure chart visuals always reflect current sliders.
  // (recompute() already does this, but slider-drag is the fast path
  //  where we never want to miss a paint frame.)
  if (!state.position) {
    drawLines(r.entry, r.stopPrice, r.liqPrice);
    paintRiskZone(r.stopPrice, r.liqPrice);
  }
}));

// ─── trade actions ────────────────────────────────────────────
$('placeBtn').addEventListener('click', () => {
  if (state.position) { toast('Close current position first', 'bad'); return; }
  const violation = checkRules({ type: 'placeOrder', side: state.side });
  if (violation) {
    toast(`Blocked: ${violation.message}`, 'bad');
    return;
  }
  const r = recompute();
  state.position = {
    coin: currentCoin,
    side: state.side,
    entry: r.entry,
    notional: r.notional,
    margin: r.margin,
    leverage: r.leverage ?? +$('i-lev').value,
    stopPrice: r.stopPrice,
    liqPrice: r.liqPrice,
    openedAt: Date.now(),
    riskAtEntry: r.dollarRisk,
  };
  drawLines(r.entry, r.stopPrice, r.liqPrice);
  paintRiskZone(r.stopPrice, r.liqPrice);
  renderPosCard();
  pollRules();
  toast(`${state.side.toUpperCase()} opened @ $${r.entry.toFixed(1)}`, 'ok');
});

// ─── modify stop (Rule 04 enforcement) ────────────────────────
function tryMoveStop(newStopPrice) {
  if (!state.position) return false;
  const v = checkRules({
    type: 'modifyStop',
    oldStop: state.position.stopPrice,
    newStop: newStopPrice,
    side: state.position.side,
    entry: state.position.entry,
  });
  if (v) {
    toast(v.message, 'warn');
    return false;
  }
  state.position.stopPrice = newStopPrice;
  drawLines(state.position.entry, state.position.stopPrice, state.position.liqPrice);
  paintRiskZone(state.position.stopPrice, state.position.liqPrice);
  toast('Stop tightened.', 'ok');
  return true;
}
window.tryMoveStop = tryMoveStop; // exposed for the live position card buttons

// ─── position rendering + lifecycle ───────────────────────────
// ── Position card: mount once, update text on every tick ──
//   Was rebuilding the entire DOM via innerHTML on every WS trade tick
//   (10-20+ times per second on real BTC) — that destroy-and-recreate
//   is what was making the whole app flicker. Now the DOM is mounted
//   once when the position opens (or coin/side changes) and subsequent
//   ticks only patch the text content + class of named spans.
const _pcKey = (p) => p ? (p.coin + ':' + p.side + ':' + p.leverage + ':' + p.notional + ':' + p.openedAt) : '';
let _pcMountedKey = '';
let _pcLastTpState = null;  // 'set' | 'unset' — gates only when TP cell structure flips

const fmtSigned$ = (n) => (n >= 0 ? '+' : '−') + '$' + Math.abs(n).toFixed(2);

function mountPosCard(p) {
  const slot = $('posCardSlot');
  slot.innerHTML = `
    <div class="pos-card ${p.side}">
      <div class="ph-grid">
        <div class="pcell headline">
          <div class="k">${(p.coin || currentCoin)}-USDC · ${p.side.toUpperCase()} · ${p.leverage}× · ${fmt0(p.notional)}</div>
          <div class="v" id="pc-net"><span class="primary">—</span><span class="sub"></span></div>
        </div>
        <div class="pcell"><span class="k">Entry</span><span class="v" id="pc-entry">—</span></div>
        <div class="pcell"><span class="k">Mark</span><span class="v" id="pc-mark"><span class="primary">—</span><span class="sub"></span></span></div>
        <div class="pcell"><span class="k" id="pc-stop-k">Stop</span><span class="v" id="pc-stop">—</span></div>
        <div class="pcell"><span class="k">Liq</span><span class="v down" id="pc-liq"><span class="primary">—</span><span class="sub"></span></span></div>
        <div class="pcell"><span class="k">Gross PnL</span><span class="v" id="pc-gross">—</span></div>
        <div class="pcell"><span class="k">Fees (round-trip)</span><span class="v down" id="pc-fees">—</span></div>
        <div class="pcell"><span class="k" id="pc-fund-k">Funding</span><span class="v" id="pc-fund">—</span></div>
        <div class="pcell" id="pc-tp-cell"><span class="k" style="color:var(--mint);">💡 Click chart to set TP</span><span class="v" style="color:var(--text-3);">— not set</span></div>
        <div class="pactions" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;min-width:200px;">
          <button id="pc-be" onclick="window.moveToBE()">Move to BE</button>
          <button onclick="window.tightenStop()">Tighten 25%</button>
          <button onclick="window.tryWidenStop()">Try widen</button>
          <button class="close-btn" onclick="window.closePos('manual')">Close</button>
        </div>
      </div>
    </div>
  `;
  // Static cells set once
  $('pc-entry').textContent = '$' + p.entry.toLocaleString('en-US', { maximumFractionDigits: 1 });
  $('pc-fees').textContent  = '−$' + (p.notional * 0.001).toFixed(2);
  _pcLastTpState = null;     // force TP cell sync on first paint
}

function _patchClass(el, prefix, cls) {
  // Replace classes that match prefix without touching unrelated ones
  el.className = (el.className.split(/\s+/).filter(c => !c.startsWith(prefix) && c !== 'up' && c !== 'down' && c !== 'warn').join(' ') + ' ' + cls).trim();
}

function renderPosCard() {
  const slot = $('posCardSlot');
  if (!state.position) {
    if (_pcMountedKey) { slot.innerHTML = ''; _pcMountedKey = ''; _pcLastTpState = null; }
    return;
  }
  const p = state.position;
  const key = _pcKey(p);
  if (key !== _pcMountedKey) {
    mountPosCard(p);
    _pcMountedKey = key;
  }

  // Live values
  const dir = p.side === 'long' ? 1 : -1;
  const movePct = ((lastClose - p.entry) * dir / p.entry) * 100;
  const grossPnl = (movePct / 100) * p.notional;
  const pnlCls  = grossPnl >= 0 ? 'up' : 'down';
  const liqDist = Math.abs(((p.liqPrice - lastClose) / lastClose) * 100);
  const totalFee = p.notional * 0.001;
  const hourlyRate = +(marketsCache.byCoin[p.coin]?.funding || 0);
  const heldHours = Math.max(0, (Date.now() - p.openedAt) / 3_600_000);
  const fundingAccrued = -dir * p.notional * hourlyRate * heldHours;
  const netPnl = grossPnl - totalFee + fundingAccrued;
  const netPct = (netPnl / p.notional) * 100;
  const netCls = netPnl >= 0 ? 'up' : 'down';
  const inProfit = movePct > 0;
  const stopAtBE = Math.abs(p.stopPrice - p.entry) / p.entry < 0.0005;
  const beDisabled = !inProfit || stopAtBE;

  // Patch persistent child spans via textContent — was rebuilding
  // innerHTML on every WS tick, which destroys+recreates the .sub
  // span every paint. At 10-20Hz × 4 cells = 40-80 DOM rebuilds/sec
  // → visible flicker on the position card text. textContent updates
  // are CPU-cheap and don't trigger layout/style recalc on siblings.
  const net = $('pc-net');
  if (net.children.length === 2) {
    net.children[0].textContent = fmtSigned$(netPnl) + ' ';
    net.children[1].textContent = `${netPct >= 0 ? '+' : ''}${netPct.toFixed(2)}% net`;
  }
  if (net._cls !== netCls) { net.className = 'v ' + netCls; net._cls = netCls; }

  const mark = $('pc-mark');
  if (mark.children.length === 2) {
    mark.children[0].textContent = '$' + lastClose.toLocaleString('en-US',{maximumFractionDigits:1}) + ' ';
    mark.children[1].textContent = `${movePct >= 0 ? '+' : ''}${movePct.toFixed(2)}%`;
  }
  if (mark._cls !== pnlCls) { mark.className = 'v ' + pnlCls; mark._cls = pnlCls; }

  $('pc-stop-k').textContent = stopAtBE ? 'Stop · BE' : 'Stop';
  const stopEl = $('pc-stop');
  stopEl.textContent = '$' + p.stopPrice.toLocaleString('en-US',{maximumFractionDigits:1});
  const stopCls = stopAtBE ? 'up' : '';
  if (stopEl._cls !== stopCls) { stopEl.className = 'v ' + stopCls; stopEl._cls = stopCls; }

  const liqEl = $('pc-liq');
  if (liqEl.children.length === 2) {
    liqEl.children[0].textContent = '$' + p.liqPrice.toLocaleString('en-US',{maximumFractionDigits:1}) + ' ';
    liqEl.children[1].textContent = `${liqDist.toFixed(2)}% away`;
  }

  const gross = $('pc-gross');
  gross.textContent = fmtSigned$(grossPnl);
  gross.className = 'v ' + pnlCls;

  $('pc-fund-k').textContent = `Funding · ${(hourlyRate*100).toFixed(4)}%/h`;
  const fund = $('pc-fund');
  fund.textContent = fmtSigned$(fundingAccrued);
  fund.className = 'v ' + (fundingAccrued >= 0 ? 'up' : 'down');

  // BE button — only restructure when its enabled state actually flips
  const beBtn = $('pc-be');
  if (beBtn) {
    beBtn.disabled = beDisabled;
    beBtn.className = beDisabled ? '' : 'be-btn';
    beBtn.textContent = stopAtBE ? '✓ At BE' : 'Move to BE';
    beBtn.title = stopAtBE
      ? 'Stop already at break-even'
      : !inProfit
        ? 'Available once trade is in profit'
        : 'Move stop to entry — locks zero loss';
  }

  // TP cell — two structural states (set vs unset). Only re-render the
  // cell when flipping between them; otherwise just patch the values.
  const tpCell = $('pc-tp-cell');
  const wantState = tpPrice != null ? 'set' : 'unset';
  if (wantState !== _pcLastTpState) {
    if (wantState === 'set') {
      // Build with persistent child spans inside pc-tp-v so the per-tick
      // update path can use textContent (no DOM thrash).
      tpCell.innerHTML = `
        <span class="k">Take Profit @ <span id="pc-tp-px">—</span> <span style="color:var(--mint);cursor:pointer;margin-left:6px;" onclick="window.clearTP()">✕</span></span>
        <span class="v" id="pc-tp-v"><span class="primary">—</span><span class="sub"></span></span>`;
    } else {
      tpCell.innerHTML = `
        <span class="k" style="color:var(--mint);">💡 Click chart to set TP</span>
        <span class="v" style="color:var(--text-3);">— not set</span>`;
    }
    _pcLastTpState = wantState;
  }
  if (wantState === 'set') {
    const tpMove = ((tpPrice - p.entry) * dir / p.entry) * 100;
    const tpUsd  = (tpMove / 100) * p.notional;
    const tpCls = tpUsd >= 0 ? 'up' : 'down';
    const pxEl = $('pc-tp-px');
    if (pxEl) pxEl.textContent = '$' + tpPrice.toFixed(1);
    const vEl = $('pc-tp-v');
    if (vEl && vEl.children.length === 2) {
      vEl.children[0].textContent = fmtSigned$(tpUsd) + ' ';
      vEl.children[1].textContent = `${tpMove >= 0 ? '+' : ''}${tpMove.toFixed(2)}%`;
      if (vEl._cls !== tpCls) { vEl.className = 'v ' + tpCls; vEl._cls = tpCls; }
    }
  }
}

function updatePositionUI() {
  const p = state.position;
  if (!p) return;
  const dir = p.side === 'long' ? 1 : -1;
  const stopHit = dir === 1 ? lastClose <= p.stopPrice : lastClose >= p.stopPrice;
  const liqHit  = dir === 1 ? lastClose <= p.liqPrice  : lastClose >= p.liqPrice;
  if (liqHit)  { closePosition('liquidated'); return; }
  if (stopHit) { closePosition('stop'); return; }

  // Refresh TP label so $/% tracks the live mark too
  refreshTPLabel();

  // Entry badge becomes a live PnL readout while position is open
  if (entryLine) {
    const movePct = ((lastClose - p.entry) * dir / p.entry) * 100;
    const pnlUsd  = (movePct / 100) * p.notional;
    const sign = pnlUsd >= 0 ? '+' : '−';
    const absUsd = Math.abs(pnlUsd);
    try {
      entryLine.applyOptions({
        title: `${sign}$${absUsd.toFixed(2)}  ${pnlUsd >= 0 ? '+' : ''}${movePct.toFixed(2)}%`,
        color: pnlUsd >= 0 ? '#a3f7bf' : '#ff7468',
      });
    } catch {}
  }

  renderPosCard();
}

function closePosition(reason) {
  const p = state.position;
  if (!p) return;
  const dir = p.side === 'long' ? 1 : -1;
  let exitPrice = lastClose;
  if (reason === 'stop')       exitPrice = p.stopPrice;
  if (reason === 'liquidated') exitPrice = p.liqPrice;
  const movePct = ((exitPrice - p.entry) * dir / p.entry) * 100;
  const pnl = (movePct / 100) * p.notional;

  // demo fee model: 0.05% taker × 2 sides on the notional
  const feesUsd = p.notional * 0.001;
  // demo funding: 0 unless held overnight (24h+)
  const heldHours = (Date.now() - p.openedAt) / 3_600_000;
  const fundingUsd = heldHours > 1 ? -p.notional * 0.0001 * Math.floor(heldHours) : 0;
  const netPnl = pnl - feesUsd + fundingUsd;
  const netPct = (netPnl / p.notional) * 100;

  // Persist trade for the dashboard History tab
  try {
    const log = JSON.parse(localStorage.getItem('hyperguard:trades') || '[]');
    log.push({
      coin: p.coin || currentCoin,
      side: p.side,
      entry: p.entry,
      exit: exitPrice,
      sizeUsd: p.notional,
      entryTime: p.openedAt,
      exitTime: Date.now(),
      pnlUsd: pnl,
      pnlPct: movePct,
      feesUsd,
      fundingUsd,
      netPnl,
      netPct,
      reason,
    });
    // keep last 200
    while (log.length > 200) log.shift();
    localStorage.setItem('hyperguard:trades', JSON.stringify(log));
  } catch (e) { console.warn('trade persist', e); }

  state.equity   += netPnl;
  state.todayPnL += netPnl;

  $('equity').textContent = fmt$(state.equity);
  const dailyPct = (state.todayPnL / state.startOfDayEquity) * 100;
  const tp = $('today-pnl');
  tp.textContent = (dailyPct >= 0 ? '+' : '') + dailyPct.toFixed(2) + '%';
  tp.className = 'v ' + (dailyPct >= 0 ? 'up' : 'down');

  // Rule 03 — meaningful loss triggers cooldown until tomorrow 8 AM
  if (pnl < -state.startOfDayEquity * 0.02) {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(8, 0, 0, 0);
    state.cooldownUntil = t.getTime();
    toast('Loss cooldown engaged. Locked until 8 AM.', 'warn');
  }

  state.position = null;
  clearLines();
  zoneEl.style.opacity = '0';
  $('posCardSlot').innerHTML = '';
  pollRules();
  recompute();

  const reasonText = { manual: 'Closed manually', stop: 'Stopped out', liquidated: '☠ LIQUIDATED' }[reason];
  toast(`${reasonText} · ${pnl >= 0 ? '+' : ''}${fmt$(pnl)}`, pnl >= 0 ? 'ok' : 'bad');
}
window.closePos = closePosition;

// expose for in-card buttons
window.tightenStop = () => {
  if (!state.position) return;
  const p = state.position;
  const dir = p.side === 'long' ? 1 : -1;
  const newStop = p.stopPrice + dir * Math.abs(p.entry - p.stopPrice) * 0.25;
  tryMoveStop(newStop);
};
window.moveToBE = () => {
  const p = state.position;
  if (!p) return;
  const dir = p.side === 'long' ? 1 : -1;
  const inProfit = ((lastClose - p.entry) * dir / p.entry) > 0;
  if (!inProfit) {
    toast('BE only available when trade is in profit', 'warn');
    return;
  }
  // tryMoveStop runs through Rule 04 — moving stop closer to entry from
  // an out-of-money side is "tightening" so it passes; if user somehow
  // tries this on a losing trade, it'd be widening and gets blocked.
  const ok = tryMoveStop(p.entry);
  if (ok) toast('Stop moved to break-even', 'ok');
};
window.tryWidenStop = () => {
  if (!state.position) return;
  const p = state.position;
  const dir = p.side === 'long' ? 1 : -1;
  const newStop = p.stopPrice - dir * Math.abs(p.entry - p.stopPrice) * 0.5;
  tryMoveStop(newStop); // will be blocked + restored
};

// ─── wallet button ────────────────────────────────────────────
$('walletBtn').addEventListener('click', async () => {
  const btn = $('walletBtn');
  if (state.walletAddress) return;
  btn.textContent = 'Connecting…';
  try {
    const addr = await wallet.connect();
    if (addr) {
      const provider = wallet.providerName() || 'Wallet';
      toast(`${provider} connected · no custody`, 'ok');
      // Auto-switch to Arbitrum (adds the chain if missing). If the user
      // rejects the prompt, the app still works in read-only mode but we
      // surface a clear nudge to switch manually.
      const onArb = await ensureArbitrum();
      if (!onArb) {
        toast('Please switch to Arbitrum One to deposit / trade', 'warn');
      }
      // Then load real HL balance and refresh the UI
      await applyConnectedUI(addr);
    } else {
      btn.textContent = 'Connect wallet';
      toast('No accounts returned', 'bad');
    }
  } catch (err) {
    btn.textContent = 'Connect wallet';
    if (err.code === 'NO_PROVIDER') {
      toast('No wallet detected. Install MetaMask or Rabby.', 'bad');
    } else if (err.code === 4001 || /reject/i.test(err.message || '')) {
      toast('Connection rejected', 'warn');
    } else {
      toast('Connect failed: ' + (err.message || err), 'bad');
    }
  }
});

// Silent restore on page load — uses eth_accounts (no popup)
(async () => {
  const addr = await wallet.silentRestore();
  if (addr) await applyConnectedUI(addr);
})();

// ─── toast ────────────────────────────────────────────────────
function toast(msg, cls = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + cls;
  setTimeout(() => { t.className = 'toast ' + cls; }, 2600);
}

// ─── Rules popover — anchors to .rules-badge in sub-header ───
function positionRulesPop() {
  const pop = document.getElementById('rulesPop');
  const trg = document.getElementById('rulesBadge');
  if (!pop || !trg) return;
  const r = trg.getBoundingClientRect();
  const w = 380;
  let left = r.right - w;
  if (left < 8) left = 8;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  pop.style.top  = (r.bottom + 8) + 'px';
  pop.style.left = left + 'px';
}
function openRulesPop() {
  const pop = document.getElementById('rulesPop');
  const trg = document.getElementById('rulesBadge');
  if (!pop || !trg) return;
  positionRulesPop();
  pop.classList.add('open');
  trg.classList.add('open');
}
function closeRulesPop() {
  document.getElementById('rulesPop')?.classList.remove('open');
  document.getElementById('rulesBadge')?.classList.remove('open');
}
document.getElementById('rulesBadge').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = document.getElementById('rulesPop');
  if (pop.classList.contains('open')) closeRulesPop();
  else openRulesPop();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#rulesBadge') && !e.target.closest('#rulesPop')) closeRulesPop();
});
window.addEventListener('resize', () => {
  if (document.getElementById('rulesPop')?.classList.contains('open')) positionRulesPop();
});
window.addEventListener('scroll', () => {
  if (document.getElementById('rulesPop')?.classList.contains('open')) positionRulesPop();
}, true);

// ─── dropdown wiring ──────────────────────────────────────────
document.getElementById('pairCoin').addEventListener('click', (e) => {
  if (e.target.closest('.markets-dd')) return;
  const dd = document.getElementById('marketsDd');
  if (dd.classList.contains('open')) closeDropdown();
  else openDropdown();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#pairCoin')) closeDropdown();
});
document.getElementById('ddSearch').addEventListener('input', renderDropdown);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDropdown();
});

// ─── boot ─────────────────────────────────────────────────────
applyPairCoinUI();
clampInputs();
updatePriceUI();
recompute();
pollRules();

// repaint risk zone on resize / scale
chart.timeScale().subscribeVisibleTimeRangeChange(() => {
  const r = state.position
    ? { stopPrice: state.position.stopPrice, liqPrice: state.position.liqPrice }
    : (() => { const x = recompute(); return x; })();
  paintRiskZone(r.stopPrice, r.liqPrice);
});
window.addEventListener('resize', () => {
  setTimeout(() => {
    const r = state.position
      ? { stopPrice: state.position.stopPrice, liqPrice: state.position.liqPrice }
      : (() => { const x = recompute(); return x; })();
    paintRiskZone(r.stopPrice, r.liqPrice);
  }, 50);
});
