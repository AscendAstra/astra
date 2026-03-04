/**
 * Market Guard — BTC Cascade Protection System
 *
 * 🟡 YELLOW — BTC down 3%+ in 1 hour     → Pause all entries
 * 🟠 ORANGE — BTC down 4%+ in 4 hours    → Pause all entries + tighten stops
 * 🔴 RED    — BTC down 5%+ in 30 minutes → Pause all entries + close momentum
 *
 * All clear — BTC stable for 4+ consecutive hours → Resume normal operations
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { log } from './logger.js';
import { notify } from './discord.js';
import { runRegimeDetection } from './regimeDetector.js';

// ── PERSISTENCE ──────────────────────────────────────────────────────────────
const DATA_DIR       = './data';
const GUARD_FILE     = './data/btc_guard.json';

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

function loadGuardState() {
  try {
    if (!existsSync(GUARD_FILE)) return null;
    const raw = readFileSync(GUARD_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    log('warn', `[MARKET GUARD] Failed to read btc_guard.json — starting fresh: ${err.message}`);
    return null;
  }
}

function saveGuardState() {
  try {
    const state = {
      btcPriceHistory:      btcPriceHistory,
      btcVolatilityHistory: btcVolatilityHistory,
      baselineVolatility:   baselineVolatility,
      currentAlertLevel:    currentAlertLevel,
      alertTriggeredAt:     alertTriggeredAt,
      stableHoursCount:     stableHoursCount,
      savedAt:              Date.now(),
    };
    writeFileSync(GUARD_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    log('error', `[MARKET GUARD] Failed to save btc_guard.json: ${err.message}`);
  }
}

// ── ALERT LEVELS ───────────────────────────────────────────────────────────────
export const ALERT_LEVEL = {
  NONE:   'NONE',
  YELLOW: 'YELLOW',
  ORANGE: 'ORANGE',
  RED:    'RED',
};

// ── STATE (restored from disk if available) ──────────────────────────────────
const ALL_CLEAR_STABLE_HOURS = 4;
const CHECK_INTERVAL_MS      = 5 * 60 * 1000;

let currentAlertLevel;
let alertTriggeredAt;
let lastBtcCheckAt    = null;
let stableHoursCount;

const btcPriceHistory      = [];
const btcVolatilityHistory = [];
let baselineVolatility;

// ── RESTORE FROM DISK ────────────────────────────────────────────────────────
{
  const saved = loadGuardState();
  const now   = Date.now();
  if (saved) {
    // Prune price history older than 5h
    const priceCutoff = now - (5 * 60 * 60 * 1000);
    if (Array.isArray(saved.btcPriceHistory)) {
      for (const e of saved.btcPriceHistory) {
        if (e.timestamp >= priceCutoff) btcPriceHistory.push(e);
      }
    }
    // Prune volatility history older than 2h
    const volCutoff = now - (2 * 60 * 60 * 1000);
    if (Array.isArray(saved.btcVolatilityHistory)) {
      for (const e of saved.btcVolatilityHistory) {
        if (e.timestamp >= volCutoff) btcVolatilityHistory.push(e);
      }
    }
    baselineVolatility = saved.baselineVolatility ?? null;
    currentAlertLevel  = Object.values(ALERT_LEVEL).includes(saved.currentAlertLevel)
      ? saved.currentAlertLevel : ALERT_LEVEL.NONE;
    alertTriggeredAt   = saved.alertTriggeredAt ?? null;
    stableHoursCount   = saved.stableHoursCount ?? 0;

    log('info', `[MARKET GUARD] Restored from disk — ${btcPriceHistory.length} price points, ${btcVolatilityHistory.length} vol points, alert: ${currentAlertLevel}`);
  } else {
    currentAlertLevel  = ALERT_LEVEL.NONE;
    alertTriggeredAt   = null;
    baselineVolatility = null;
    stableHoursCount   = 0;
  }
}

// ── THRESHOLDS ─────────────────────────────────────────────────────────────────
const YELLOW_BTC_DROP_1H_PCT    = 3;
const ORANGE_BTC_DROP_4H_PCT    = 4;
const ORANGE_LIQUIDATION_USD    = 150_000_000;
const RED_BTC_DROP_30M_PCT      = 5;
const RED_VOLATILITY_MULTIPLIER = 10;

// ── FETCH BTC PRICE ────────────────────────────────────────────────────────────
async function fetchBtcPrice() {
  try {
    const res  = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
    const data = await res.json();
    return data?.bitcoin?.usd ?? null;
  } catch (err) {
    log('error', `[MARKET GUARD] BTC price fetch failed: ${err.message}`);
    return null;
  }
}

// ── LIQUIDATION PROXY ──────────────────────────────────────────────────────────
function fetchHourlyLiquidations() {
  const drop4h = getBtcDropOverWindow(4 * 60 * 60 * 1000);
  if (drop4h >= ORANGE_BTC_DROP_4H_PCT) {
    log('warn', `[MARKET GUARD] BTC 4h drop ${drop4h.toFixed(2)}% — elevated liquidation risk (Orange proxy)`);
    return 200_000_000;
  }
  return 0;
}

// ── PRICE HISTORY HELPERS ──────────────────────────────────────────────────────
function recordBtcPrice(price) {
  const now    = Date.now();
  const cutoff = now - (5 * 60 * 60 * 1000);
  btcPriceHistory.push({ price, timestamp: now });
  while (btcPriceHistory.length > 0 && btcPriceHistory[0].timestamp < cutoff) {
    btcPriceHistory.shift();
  }
}

function getBtcDropOverWindow(windowMs) {
  if (btcPriceHistory.length < 2) return 0;
  const cutoff        = Date.now() - windowMs;
  const windowEntries = btcPriceHistory.filter(e => e.timestamp >= cutoff);
  if (windowEntries.length < 2) return 0;
  const oldest = windowEntries[0].price;
  const newest = windowEntries[windowEntries.length - 1].price;
  return ((oldest - newest) / oldest) * 100;
}

function recordBtcVolatility(price) {
  if (btcPriceHistory.length < 2) return;
  const prev      = btcPriceHistory[btcPriceHistory.length - 2].price;
  const changePct = Math.abs((price - prev) / prev) * 100;
  const cutoff    = Date.now() - (2 * 60 * 60 * 1000);

  btcVolatilityHistory.push({ changePct, timestamp: Date.now() });
  while (btcVolatilityHistory.length > 0 && btcVolatilityHistory[0].timestamp < cutoff) {
    btcVolatilityHistory.shift();
  }

  if (!baselineVolatility && btcVolatilityHistory.length >= 6) {
    const baseline    = btcVolatilityHistory.slice(0, 6);
    baselineVolatility = baseline.reduce((sum, e) => sum + e.changePct, 0) / baseline.length;
    log('info', `[MARKET GUARD] Baseline 5m BTC volatility set: ${baselineVolatility.toFixed(4)}%`);
  }
}

function getCurrentVolatility() {
  if (btcVolatilityHistory.length === 0) return 0;
  const recent = btcVolatilityHistory.slice(-3);
  return recent.reduce((sum, e) => sum + e.changePct, 0) / recent.length;
}

// ── ALERT STATE MANAGEMENT ─────────────────────────────────────────────────────
async function setAlert(level, reason) {
  if (level === currentAlertLevel) return;

  const prev        = currentAlertLevel;
  currentAlertLevel = level;

  if (level === ALERT_LEVEL.NONE) {
    log('info', `[MARKET GUARD] ✅ ALL CLEAR — Market stable for ${ALL_CLEAR_STABLE_HOURS}h. Resuming normal operations.`);
    alertTriggeredAt = null;
    stableHoursCount = 0;
    await notify.allClear(btcPriceHistory.at(-1)?.price);
  } else {
    alertTriggeredAt = Date.now();
    stableHoursCount = 0;
    const emoji = level === ALERT_LEVEL.YELLOW ? '🟡' :
                  level === ALERT_LEVEL.ORANGE ? '🟠' : '🔴';
    log('warn', `[MARKET GUARD] ${emoji} ${level} ALERT — ${reason}`);
    if (prev !== ALERT_LEVEL.NONE) {
      log('warn', `[MARKET GUARD] Alert escalated: ${prev} → ${level}`);
    }
    await notify.marketAlert(level, reason, btcPriceHistory.at(-1)?.price);
  }
  saveGuardState();
}

// ── STABILITY CHECK ────────────────────────────────────────────────────────────
async function checkIfStable(btcDrop1h, btcDrop30m, liquidations) {
  if (currentAlertLevel === ALERT_LEVEL.NONE) return;

  const isStable = btcDrop1h < 1 && btcDrop30m < 1 && liquidations < 50_000_000;

  if (isStable) {
    stableHoursCount += (CHECK_INTERVAL_MS / (60 * 60 * 1000));
    if (stableHoursCount >= ALL_CLEAR_STABLE_HOURS) {
      await setAlert(ALERT_LEVEL.NONE, 'Market stable');
    } else {
      const hrsLeft = (ALL_CLEAR_STABLE_HOURS - stableHoursCount).toFixed(1);
      log('info', `[MARKET GUARD] Market stabilizing — all clear in ~${hrsLeft}h`);
    }
  } else {
    stableHoursCount = 0;
  }
}

// ── MAIN CHECK LOOP ────────────────────────────────────────────────────────────
export async function runMarketGuardCheck() {
  const now = Date.now();

  if (lastBtcCheckAt && now - lastBtcCheckAt < CHECK_INTERVAL_MS) return;
  lastBtcCheckAt = now;

  const btcPrice = await fetchBtcPrice();
  if (!btcPrice) {
    log('warn', '[MARKET GUARD] Could not fetch BTC price — skipping guard check.');
    return;
  }

  recordBtcPrice(btcPrice);
  recordBtcVolatility(btcPrice);

  const btcDrop1h    = getBtcDropOverWindow(60 * 60 * 1000);
  const btcDrop30m   = getBtcDropOverWindow(30 * 60 * 1000);
  const btcDrop4h    = getBtcDropOverWindow(4 * 60 * 60 * 1000);
  const liquidations = fetchHourlyLiquidations();

  const currentVol           = getCurrentVolatility();
  const volatilityMultiplier = baselineVolatility && baselineVolatility > 0
    ? currentVol / baselineVolatility : 0;

  log('info', `[MARKET GUARD] BTC: $${btcPrice.toLocaleString()} | 1h: ${btcDrop1h.toFixed(2)}% | 30m: ${btcDrop30m.toFixed(2)}% | 4h: ${btcDrop4h.toFixed(2)}% | Vol: ${volatilityMultiplier.toFixed(1)}x`);

  // ── REGIME DETECTION (piggybacks on this 5-min check) ───────────────────
  await runRegimeDetection(btcPriceHistory, btcVolatilityHistory, baselineVolatility);

  // ── RED ────────────────────────────────────────────────────────────────────
  if (btcDrop30m >= RED_BTC_DROP_30M_PCT || (baselineVolatility && volatilityMultiplier >= RED_VOLATILITY_MULTIPLIER)) {
    const reason = btcDrop30m >= RED_BTC_DROP_30M_PCT
      ? `BTC dropped ${btcDrop30m.toFixed(2)}% in 30 minutes`
      : `BTC volatility spiked ${volatilityMultiplier.toFixed(1)}x above baseline`;
    await setAlert(ALERT_LEVEL.RED, reason);
    return;
  }

  // ── ORANGE ─────────────────────────────────────────────────────────────────
  if (liquidations >= ORANGE_LIQUIDATION_USD) {
    await setAlert(ALERT_LEVEL.ORANGE, `BTC dropped ${btcDrop4h.toFixed(2)}% in 4 hours — liquidation cascade risk`);
    return;
  }

  // ── YELLOW ─────────────────────────────────────────────────────────────────
  if (btcDrop1h >= YELLOW_BTC_DROP_1H_PCT) {
    await setAlert(ALERT_LEVEL.YELLOW, `BTC dropped ${btcDrop1h.toFixed(2)}% in the last hour`);
    return;
  }

  await checkIfStable(btcDrop1h, btcDrop30m, liquidations);

  saveGuardState();
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────────
export function getAlertLevel()     { return currentAlertLevel; }
export function isMarketDangerous() { return currentAlertLevel !== ALERT_LEVEL.NONE; }
export function isRedAlert()        { return currentAlertLevel === ALERT_LEVEL.RED; }
export function isOrangeOrAbove()   { return currentAlertLevel === ALERT_LEVEL.ORANGE || currentAlertLevel === ALERT_LEVEL.RED; }
export function getMarketGuardStatus() {
  return { alertLevel: currentAlertLevel, alertTriggeredAt, stableHoursCount: stableHoursCount.toFixed(1), baselineVolatility };
}

// ── REGIME DETECTOR DATA ACCESS ─────────────────────────────────────────────
export function getBtcPriceHistory()      { return btcPriceHistory; }
export function getBtcVolatilityHistory() { return btcVolatilityHistory; }
export function getBaselineVolatility()   { return baselineVolatility; }
