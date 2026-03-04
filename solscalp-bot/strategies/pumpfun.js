/**
 * Strategy 4: Pump.fun Pre-Migration Scalp ("Final Stretch")
 * Inspired by Decu0x — buy momentum on bonding curve, sell before graduation.
 *
 * Entry: MC $6K–$60K on Pump.fun bonding curve, age ≤60min, volume ≥25 SOL, buy pressure ≥60%
 *         Alpha tokens: MC $4K+, volume ≥10 SOL, buy pressure ≥55% (relaxed — detected early)
 * Exit:  +25% target | -20% stop loss | MC ceiling $60K (approaching graduation) | 10min stale
 *
 * Discovery: PumpPortal WebSocket (real-time trade events)
 * Execution: Jupiter (routes through Pump.fun bonding curve)
 */

import { PumpPortalWS } from '../pumpfun/portal.js';
import { buildBuyTransaction, buildSellTransaction, calculateSlippage } from '../jupiter/index.js';
import { signAndSendTransaction, getWalletAddress, getWalletBalance } from '../wallet/custodial.js';
import {
  createTrade,
  hasActiveTradeForToken,
  getActiveTrades,
  isDailyLossLimitReached,
  closeTrade,
} from '../store/trades.js';
import { loadSettings } from '../config/settings.js';
import { log } from '../utils/logger.js';
import { notify } from '../utils/discord.js';
import { runMarketGuardCheck, isMarketDangerous, getAlertLevel } from '../utils/marketGuard.js';
import {
  getStopLossCooldown,
  setStopLossCooldown,
  isConsecutiveStopPauseActive,
  getEntryCount,
  recordEntry,
} from '../utils/cooldownStore.js';
import { isTokenBlocked } from '../utils/contentFilter.js';
import {
  matchAlphaSource,
  tagAlphaToken,
  isAlphaToken,
  getAlphaToken,
  recordAlphaStage,
  loadAlphaSources,
} from '../store/alphaTokens.js';

const STRATEGY = 'pumpfun';
const COOLDOWN_MS = 30 * 60 * 1000; // 30 min per-token cooldown after stop loss
const GRADUATION_MC = 69_000;        // Approximate graduation MC on Pump.fun

// ── IN-MEMORY STATE ─────────────────────────────────────────────────────────

/** @type {Map<string, WatchlistEntry>} mint → candidate data */
const watchlist = new Map();

/** @type {Map<string, PositionTracker>} mint → position price tracking */
const positions = new Map();

/** @type {Set<string>} mints currently being bought — prevents race condition duplicate entries */
const pendingBuys = new Set();

/** @type {Set<string>} mints currently being sold — prevents race condition duplicate exits */
const pendingSells = new Set();

let portal = null;
let maintenanceTimer = null;
let _settings = null;
let _loggedTradeSample = false; // TEMPORARY — remove after confirming PumpPortal field names

// ── SOL PRICE CACHE (for marketCapSol → USD conversion) ────────────────────
let _solPriceUsd = 140; // fallback
let _solPriceLastFetch = 0;
const SOL_PRICE_TTL_MS = 5 * 60 * 1000; // refresh every 5 min

async function getSolPrice() {
  if (Date.now() - _solPriceLastFetch < SOL_PRICE_TTL_MS) return _solPriceUsd;
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await res.json();
    if (data?.solana?.usd) {
      _solPriceUsd = data.solana.usd;
      _solPriceLastFetch = Date.now();
    }
  } catch { /* keep last known price */ }
  return _solPriceUsd;
}

// Rate limiter for pump.fun description fetches
let _lastAlphaFetchAt = 0;

// ── THROTTLED REJECTION LOGGER ──────────────────────────────────────────────
// Logs each token+reason combo at most once per 30s to avoid flooding.
const _rejectLog = new Map(); // key: `${mint}:${reason}` → timestamp

function logReject(mint, symbol, reason, details = '') {
  const key = `${mint}:${reason}`;
  const now = Date.now();
  const last = _rejectLog.get(key);
  if (last && now - last < 30_000) return; // throttled
  _rejectLog.set(key, now);
  const detail = details ? ` (${details})` : '';
  log('info', `[PUMPFUN] SKIP ${symbol} — ${reason}${detail}`);
}

// ── WATCHLIST ENTRY SHAPE ───────────────────────────────────────────────────
// {
//   mint, symbol, name, created_at,
//   sol_volume, buy_count, sell_count,
//   last_price, estimated_mc, buy_pressure,
//   last_trade_at
// }

// ── MAIN ENTRY POINT ────────────────────────────────────────────────────────

export function startPumpfunStrategy(settings) {
  _settings = settings;

  if (!settings.pumpfun_enabled) {
    log('info', '[PUMPFUN] Strategy disabled. Skipping.');
    return;
  }

  // Fetch SOL price immediately on startup
  getSolPrice().then(p => log('info', `[PUMPFUN] SOL price cached: $${p}`)).catch(() => {});

  log('info', `[PUMPFUN] Starting pre-migration strategy (WebSocket mode)${settings.pumpfun_alpha_only ? ' — ALPHA ONLY' : ''}...`);

  portal = new PumpPortalWS();
  portal.connect({
    onNewToken: handleNewToken,
    onTrade:    handleTrade,
  });

  // Maintenance loop — prune old candidates, check stale positions
  maintenanceTimer = setInterval(() => runMaintenance(), 60_000);
}

// ── EVENT HANDLERS ──────────────────────────────────────────────────────────

function handleNewToken(data) {
  const settings = loadSettings();
  if (!settings.pumpfun_enabled) return;

  const mint = data.mint;
  if (!mint) return;

  // Content filter — block offensive tokens before they enter watchlist
  if (isTokenBlocked(data.symbol || data.name || '', data.name || '', settings)) return;

  // Add to watchlist
  watchlist.set(mint, {
    mint,
    symbol:       data.symbol || data.name || mint.slice(0, 8),
    name:         data.name || '',
    created_at:   Date.now(),
    sol_volume:   0,
    buy_count:    0,
    sell_count:   0,
    last_price:   0,
    estimated_mc: 0,
    buy_pressure: 50,
    last_trade_at: Date.now(),
  });

  // Subscribe to trade events for this token
  portal.subscribeTokenTrade([mint]);

  // Async alpha detection — don't block the WebSocket handler
  const settings2 = loadSettings();
  if (settings2.alpha_tracking_enabled) {
    detectAlphaSource(mint, data.symbol || data.name || mint.slice(0, 8)).catch(() => {});
  }
}

function handleTrade(data) {
  const settings = loadSettings();
  if (!settings.pumpfun_enabled) return;

  const mint = data.mint;
  if (!mint) return;

  const solAmount   = parseFloat(data.solAmount  || data.sol_amount  || 0);
  const tokenAmount = parseFloat(data.tokenAmount || data.token_amount || 0);
  const isBuy       = data.txType === 'buy' || data.is_buy === true;

  // TEMPORARY — log one sample trade event to discover exact field names
  if (!_loggedTradeSample) {
    log('info', `[PUMPFUN] Sample trade data: ${JSON.stringify(data).slice(0, 500)}`);
    _loggedTradeSample = true;
  }

  // Update watchlist entry if exists
  const candidate = watchlist.get(mint);
  if (candidate) {
    candidate.sol_volume += solAmount;
    if (isBuy) candidate.buy_count++;
    else candidate.sell_count++;

    const totalTx = candidate.buy_count + candidate.sell_count;
    candidate.buy_pressure = totalTx > 0 ? (candidate.buy_count / totalTx) * 100 : 50;

    // Use PumpPortal's marketCapSol for MC estimation (fixes $0 MC bug from hardcoded TOTAL_SUPPLY)
    const marketCapSol = parseFloat(data.marketCapSol || data.market_cap_sol || 0);
    if (marketCapSol > 0) {
      // Convert SOL MC to USD — try available SOL price fields, fall back to rough estimate
      const solPrice = parseFloat(data.solPrice || data.sol_price || 0);
      candidate.estimated_mc = solPrice > 0
        ? marketCapSol * solPrice
        : marketCapSol * _solPriceUsd;
    } else if (data.vSolInBondingCurve) {
      // Fallback: bonding curve MC ≈ vSolInBondingCurve * 2 * SOL price
      const vSol = parseFloat(data.vSolInBondingCurve);
      candidate.estimated_mc = vSol * 2 * _solPriceUsd;
    }

    // Keep price tracking for P&L — use bonding curve spot price, not per-trade ratio.
    // Per-trade solAmount/tokenAmount can spike wildly on small trades, causing fake P&L.
    const vSolCandidate  = parseFloat(data.vSolInBondingCurve || 0);
    const vTokenCandidate = parseFloat(data.vTokensInBondingCurve || 0);
    if (vSolCandidate > 0 && vTokenCandidate > 0) {
      candidate.last_price = vSolCandidate / vTokenCandidate;
    } else if (tokenAmount > 0 && solAmount > 0) {
      candidate.last_price = solAmount / tokenAmount; // fallback if curve data missing
    }
    candidate.last_trade_at = Date.now();
  }

  // Update position price tracking if we own this token
  const pos = positions.get(mint);
  if (pos) {
    // Use bonding curve spot price — not per-trade ratio which spikes on small trades
    const vSolPos  = parseFloat(data.vSolInBondingCurve || 0);
    const vTokenPos = parseFloat(data.vTokensInBondingCurve || 0);
    if (vSolPos > 0 && vTokenPos > 0) {
      pos.current_price = vSolPos / vTokenPos;
    } else if (tokenAmount > 0 && solAmount > 0) {
      pos.current_price = solAmount / tokenAmount; // fallback
    }
    // Use marketCapSol for MC if available, otherwise estimate from candidate
    const mCapSol = parseFloat(data.marketCapSol || data.market_cap_sol || 0);
    if (mCapSol > 0) {
      const sp = parseFloat(data.solPrice || data.sol_price || 0);
      pos.estimated_mc = sp > 0 ? mCapSol * sp : mCapSol * _solPriceUsd;
    } else if (candidate) {
      pos.estimated_mc = candidate.estimated_mc;
    }
    if (pos.current_price > pos.highest_price) {
      pos.highest_price = pos.current_price;
    }

    // Check exits for owned position
    checkPositionExits(mint, settings);
    return; // Don't evaluate for entry if we already own it
  }

  // Evaluate for entry if we don't own it (pendingBuys prevents race condition duplicates)
  if (candidate && !hasActiveTradeForToken(mint, STRATEGY) && !pendingBuys.has(mint)) {
    evaluateCandidate(candidate, settings);
  }
}

// ── CANDIDATE EVALUATION ────────────────────────────────────────────────────

async function evaluateCandidate(candidate, settings) {
  // 0. Alpha-only mode — skip non-alpha tokens entirely
  if (settings.pumpfun_alpha_only && !isAlphaToken(candidate.mint)) return;

  const {
    pumpfun_max_mc,
    pumpfun_max_age_minutes,
    pumpfun_max_concurrent,
    daily_loss_limit_sol,
  } = settings;

  // Alpha tokens get relaxed filters (detected early at ~$4K MC, low initial volume)
  const alpha = isAlphaToken(candidate.mint);
  const minMc        = alpha ? (settings.pumpfun_alpha_min_mc           || 4000) : settings.pumpfun_min_mc;
  const minVolume    = alpha ? (settings.pumpfun_alpha_min_sol_volume   || 10)   : settings.pumpfun_min_sol_volume;
  const minBuyPress  = alpha ? (settings.pumpfun_alpha_min_buy_pressure || 55)   : settings.pumpfun_min_buy_pressure;

  // 1. MC range
  if (candidate.estimated_mc < minMc || candidate.estimated_mc > pumpfun_max_mc) {
    logReject(candidate.mint, candidate.symbol, 'MC out of range', `$${(candidate.estimated_mc / 1000).toFixed(1)}K vs $${(minMc / 1000).toFixed(0)}K-$${(pumpfun_max_mc / 1000).toFixed(0)}K${alpha ? ' [alpha]' : ''}`);
    return;
  }

  // 2. Age check
  const ageMinutes = (Date.now() - candidate.created_at) / 60_000;
  if (ageMinutes > pumpfun_max_age_minutes) {
    logReject(candidate.mint, candidate.symbol, 'too old', `${ageMinutes.toFixed(0)}m > ${pumpfun_max_age_minutes}m`);
    return;
  }

  // 3. Volume check
  if (candidate.sol_volume < minVolume) {
    logReject(candidate.mint, candidate.symbol, 'low volume', `${candidate.sol_volume.toFixed(1)} SOL < ${minVolume} SOL${alpha ? ' [alpha]' : ''}`);
    return;
  }

  // 4. Buy pressure
  if (candidate.buy_pressure < minBuyPress) {
    logReject(candidate.mint, candidate.symbol, 'low buy pressure', `${candidate.buy_pressure.toFixed(0)}% < ${minBuyPress}%${alpha ? ' [alpha]' : ''}`);
    return;
  }

  // 5. Concurrent positions cap
  const activePumpfun = getActiveTrades().filter(t => t.strategy === STRATEGY);
  if (activePumpfun.length >= pumpfun_max_concurrent) {
    logReject(candidate.mint, candidate.symbol, 'max concurrent', `${activePumpfun.length}/${pumpfun_max_concurrent}`);
    return;
  }

  // 6. Already have active trade for this token
  if (hasActiveTradeForToken(candidate.mint, STRATEGY)) {
    logReject(candidate.mint, candidate.symbol, 'already active');
    return;
  }

  // 7. Per-token cooldown
  const lastStop = getStopLossCooldown(candidate.mint);
  if (lastStop && Date.now() - lastStop < COOLDOWN_MS) {
    const cdRemain = ((COOLDOWN_MS - (Date.now() - lastStop)) / 60_000).toFixed(0);
    logReject(candidate.mint, candidate.symbol, 'cooldown', `${cdRemain}m / ${COOLDOWN_MS / 60_000}m`);
    return;
  }

  // 8. Re-entry limit: max 1 entry per token per 24h
  const entryCount = getEntryCount(candidate.mint, 24 * 60 * 60 * 1000);
  if (entryCount >= 1) {
    logReject(candidate.mint, candidate.symbol, 're-entry cap', `${entryCount}/1 in 24h`);
    return;
  }

  // 9. Daily loss limit
  if (isDailyLossLimitReached(daily_loss_limit_sol)) {
    logReject(candidate.mint, candidate.symbol, 'daily loss limit');
    return;
  }

  // 10. Market guard
  if (isMarketDangerous()) {
    log('info', `[PUMPFUN] Market guard active (${getAlertLevel()}). Skip ${candidate.symbol}.`);
    return;
  }

  // 11. Consecutive stop pause
  if (isConsecutiveStopPauseActive()) {
    logReject(candidate.mint, candidate.symbol, 'consecutive stop pause');
    return;
  }

  // 12. Balance check
  const balance = await getWalletBalance();
  if (balance < settings.pumpfun_trade_amount_sol) {
    logReject(candidate.mint, candidate.symbol, 'insufficient balance', `${balance.toFixed(3)} SOL < ${settings.pumpfun_trade_amount_sol} SOL`);
    return;
  }

  const curvePct = Math.min(99, (candidate.estimated_mc / GRADUATION_MC) * 100);

  const alphaTag = alpha ? ' [ALPHA]' : '';
  log('info', `[PUMPFUN]${alphaTag} Candidate: ${candidate.symbol} — MC: $${(candidate.estimated_mc / 1000).toFixed(1)}K | Vol: ${candidate.sol_volume.toFixed(1)} SOL | Buy: ${candidate.buy_pressure.toFixed(0)}% | Curve: ~${curvePct.toFixed(0)}% | Age: ${ageMinutes.toFixed(0)}m`);

  await executeBuy(candidate, settings, curvePct);
}

// ── BUY EXECUTION ───────────────────────────────────────────────────────────

async function executeBuy(candidate, settings, curvePct) {
  // Lock to prevent duplicate entries from rapid WebSocket events
  if (pendingBuys.has(candidate.mint)) return;
  pendingBuys.add(candidate.mint);

  const walletAddress = getWalletAddress();
  const slippageBps = calculateSlippage(
    settings.pumpfun_trade_amount_sol,
    candidate.estimated_mc * 0.1, // Rough liquidity estimate (bonding curve)
    150,
    0 // No 5m volatility data from WebSocket
  );

  log('info', `[PUMPFUN] Buying ${candidate.symbol} — ${settings.pumpfun_trade_amount_sol} SOL | slippage: ${slippageBps}bps`);

  try {
    const { swapTx, quote } = await buildBuyTransaction(
      candidate.mint,
      settings.pumpfun_trade_amount_sol,
      slippageBps,
      walletAddress
    );

    const sig = await signAndSendTransaction(swapTx);

    const trade = createTrade({
      strategy:            STRATEGY,
      token_symbol:        candidate.symbol,
      token_address:       candidate.mint,
      entry_price:         candidate.last_price,
      entry_market_cap:    candidate.estimated_mc,
      amount_sol:          settings.pumpfun_trade_amount_sol,
      token_amount:        parseInt(quote.outAmount),
      target_gain_percent: settings.pumpfun_target_gain_pct,
      stop_loss_percent:   settings.pumpfun_stop_loss_pct,
      tx_signature_entry:  sig,
      entry_curve_pct:     curvePct,
      entry_sol_volume:    candidate.sol_volume,
      entry_buy_pressure:  candidate.buy_pressure,
      entry_age_minutes:   (Date.now() - candidate.created_at) / 60_000,
    });

    // Start tracking position
    positions.set(candidate.mint, {
      trade_id:      trade.id,
      entry_price:   candidate.last_price,
      current_price: candidate.last_price,
      highest_price: candidate.last_price,
      estimated_mc:  candidate.estimated_mc,
      entry_time:    Date.now(),
      token_amount:  parseInt(quote.outAmount),
    });

    recordEntry(candidate.mint, STRATEGY);

    // Alpha stage tracking
    if (settings.alpha_tracking_enabled && isAlphaToken(candidate.mint)) {
      recordAlphaStage(candidate.mint, STRATEGY, candidate.estimated_mc);
      const alpha = getAlphaToken(candidate.mint);
      const sources = loadAlphaSources();
      const sourceLabel = sources.find(s => s.id === alpha.source)?.label || alpha.source;
      log('info', `[PUMPFUN] \u{1F3F7} Alpha token entering: ${candidate.symbol} (${sourceLabel}) — stage 1`);
      notify.alphaStageEntry({ symbol: candidate.symbol }, sourceLabel, STRATEGY, candidate.estimated_mc).catch(() => {});
    }

    log('info', `[PUMPFUN] Entered ${candidate.symbol} | MC: $${(candidate.estimated_mc / 1000).toFixed(1)}K | Curve: ~${curvePct.toFixed(0)}% | Tx: ${sig}`);

    await notify.tradeOpen({
      strategy:         STRATEGY,
      token_symbol:     candidate.symbol,
      entry_market_cap: candidate.estimated_mc,
      amount_sol:       settings.pumpfun_trade_amount_sol,
      quality_score:    0,
      vol_multiplier:   0,
      exit_mc_min:      settings.pumpfun_max_mc,
    });
  } catch (err) {
    log('error', `[PUMPFUN] Buy failed for ${candidate.symbol}: ${err.message}`);
    pendingBuys.delete(candidate.mint); // unlock on failure so it can retry
  }
}

// ── POSITION EXIT CHECKS ────────────────────────────────────────────────────

async function checkPositionExits(mint, settings) {
  const pos = positions.get(mint);
  if (!pos) return;

  const pnlPct = ((pos.current_price - pos.entry_price) / pos.entry_price) * 100;

  // 1. Target gain
  if (pnlPct >= settings.pumpfun_target_gain_pct) {
    log('info', `[PUMPFUN] Target hit: +${pnlPct.toFixed(1)}% on ${mint.slice(0, 8)}... Selling.`);
    await executeSell(mint, 'target', pos.current_price, settings);
    return;
  }

  // 2. Sell pressure detection (WebSocket-based buy_pressure)
  if (settings.pumpfun_sell_pressure_enabled && pnlPct > 0) {
    const candidate = watchlist.get(mint);
    if (candidate && candidate.buy_pressure < settings.pumpfun_sell_pressure_threshold) {
      log('info', `[PUMPFUN] ${candidate.symbol} — Sell pressure detected (${candidate.buy_pressure.toFixed(0)}% buys). Exiting at +${pnlPct.toFixed(1)}%.`);
      await executeSell(mint, 'sell_pressure', pos.current_price, settings);
      return;
    }
  }

  // 3. Stop loss
  if (pnlPct <= -settings.pumpfun_stop_loss_pct) {
    log('warn', `[PUMPFUN] Stop loss: ${pnlPct.toFixed(1)}% on ${mint.slice(0, 8)}... Selling.`);
    await executeSell(mint, 'stop_loss', pos.current_price, settings);
    return;
  }

  // 4. MC ceiling — approaching graduation, sell before migration
  if (pos.estimated_mc >= settings.pumpfun_max_mc) {
    log('info', `[PUMPFUN] MC ceiling ($${(pos.estimated_mc / 1000).toFixed(1)}K ≥ $${(settings.pumpfun_max_mc / 1000).toFixed(0)}K) — selling before graduation.`);
    await executeSell(mint, 'mc_ceiling', pos.current_price, settings);
    return;
  }
}

// ── SELL EXECUTION ──────────────────────────────────────────────────────────

async function executeSell(mint, reason, currentPrice, settings) {
  const pos = positions.get(mint);
  if (!pos) return;

  // Lock to prevent duplicate sells from rapid WebSocket events
  if (pendingSells.has(mint)) return;
  pendingSells.add(mint);

  const walletAddress = getWalletAddress();
  const slippageBps = calculateSlippage(
    settings.pumpfun_trade_amount_sol,
    pos.estimated_mc * 0.1,
    150,
    reason === 'stop_loss' ? -20 : 0,
    { isSell: true }
  );

  log('info', `[PUMPFUN] Selling ${mint.slice(0, 8)}... — reason: ${reason} | slippage: ${slippageBps}bps`);

  try {
    const { swapTx, quote } = await buildSellTransaction(
      mint,
      pos.token_amount,
      slippageBps,
      walletAddress
    );

    const sig = await signAndSendTransaction(swapTx);
    const exitPrice = currentPrice || pos.current_price;

    closeTrade(pos.trade_id, exitPrice, sig, reason);

    const pnlPct = ((exitPrice - pos.entry_price) / pos.entry_price) * 100;
    const pnlSol = settings.pumpfun_trade_amount_sol * (pnlPct / 100);

    log('info', `[PUMPFUN] Sold ${mint.slice(0, 8)}... | ${pnlPct.toFixed(1)}% | ${pnlSol.toFixed(4)} SOL | reason: ${reason} | Tx: ${sig}`);

    // Record stop loss for cooldown tracking
    // Note: pumpfun does NOT trigger the global consecutive stop pause —
    // bonding curve tokens are inherently volatile and rapid stops are normal.
    // Triggering the global pause would block momentum/breakout for 90min.
    if (reason === 'stop_loss') {
      setStopLossCooldown(mint);
    }

    // Clean up position tracking + sell lock
    positions.delete(mint);
    watchlist.delete(mint);
    pendingSells.delete(mint);

    await notify.tradeClose({
      strategy:     STRATEGY,
      token_symbol: mint.slice(0, 8),
      pnl_percent:  pnlPct,
      pnl_sol:      pnlSol,
      exit_reason:  reason,
    });
  } catch (err) {
    pendingSells.delete(mint); // unlock on failure
    log('error', `[PUMPFUN] Sell failed for ${mint.slice(0, 8)}...: ${err.message}`);
  }
}

// ── ALPHA SOURCE DETECTION ───────────────────────────────────────────────────

async function detectAlphaSource(mint, symbol) {
  // Rate limit: skip if <200ms since last fetch
  const now = Date.now();
  if (now - _lastAlphaFetchAt < 200) return;
  _lastAlphaFetchAt = now;

  try {
    const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`);
    if (!res.ok) return;

    const data = await res.json();
    const description = data.description || '';
    if (!description) return;

    const sourceId = matchAlphaSource(description);
    if (!sourceId) return;

    tagAlphaToken(mint, symbol, sourceId);
    const sources = loadAlphaSources();
    const sourceLabel = sources.find(s => s.id === sourceId)?.label || sourceId;
    log('info', `[PUMPFUN] \u{1F3F7} Alpha token detected: ${symbol} (${sourceLabel})`);
  } catch {
    // Silently ignore fetch errors — non-critical
  }
}

// ── MAINTENANCE ─────────────────────────────────────────────────────────────

function runMaintenance() {
  const settings = loadSettings();
  if (!settings.pumpfun_enabled) return;

  const now = Date.now();
  const maxAgeMs = settings.pumpfun_max_age_minutes * 60_000;

  // Prune old watchlist entries
  let pruned = 0;
  for (const [mint, entry] of watchlist) {
    if (now - entry.created_at > maxAgeMs && !positions.has(mint)) {
      watchlist.delete(mint);
      portal.unsubscribeTokenTrade([mint]);
      pruned++;
    }
  }

  // Check stale positions
  for (const [mint, pos] of positions) {
    const holdMs = now - pos.entry_time;
    if (holdMs > settings.pumpfun_stale_timeout_ms) {
      log('warn', `[PUMPFUN] Stale position: ${mint.slice(0, 8)}... held ${(holdMs / 60_000).toFixed(0)}min. Selling.`);
      executeSell(mint, 'stale', pos.current_price, settings);
    }
  }

  // Clean up stale rejection log entries (older than 60s)
  for (const [key, ts] of _rejectLog) {
    if (now - ts > 60_000) _rejectLog.delete(key);
  }

  // Run market guard check periodically
  runMarketGuardCheck().catch(() => {});

  if (watchlist.size > 0 || positions.size > 0) {
    log('info', `[PUMPFUN] Watchlist: ${watchlist.size} tokens | Positions: ${positions.size} active | Pruned: ${pruned}`);
  }
}

// ── EXPORTED FOR MONITOR FALLBACK ────────────────────────────────────────────

/**
 * Record a pumpfun stop loss from external monitors (activeTrades / fastStopLoss).
 * Sets cooldown + consecutive check, and cleans up in-memory state to prevent
 * conflict with WebSocket exit logic.
 */
export function recordPumpfunStopLoss(tokenAddress) {
  setStopLossCooldown(tokenAddress);
  positions.delete(tokenAddress);
  watchlist.delete(tokenAddress);
}

// ── EXPORTED FOR INDEX.JS ───────────────────────────────────────────────────

export function stopPumpfunStrategy() {
  if (portal) portal.close();
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  log('info', '[PUMPFUN] Strategy stopped.');
}
