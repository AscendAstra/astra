/**
 * Strategy 2: Momentum / Pump.fun Graduation Sniper
 * Entry: $80K–$150K MC + 2x volume momentum
 * Exit: $135K MC
 * Stop Loss: -20%
 */
import { runMarketGuardCheck, isMarketDangerous, getAlertLevel } from '../utils/marketGuard.js';
import { fetchTopSolanaTokens } from '../dexscreener/index.js';
import { evaluateTokenQuality, basicHoneypotCheck } from '../analysis/scoring.js';
import { buildBuyTransaction, calculateSlippage } from '../jupiter/index.js';
import { signAndSendTransaction, getWalletAddress, getWalletBalance } from '../wallet/custodial.js';
import {
  createTrade,
  hasActiveTradeForToken,
  isDailyLossLimitReached,
} from '../store/trades.js';
import { loadSettings } from '../config/settings.js';
import { log } from '../utils/logger.js';
import {
  getStopLossCooldown,
  setStopLossCooldown,
  getConsecutiveStopPauseUntil,
  setConsecutiveStopPause,
  clearConsecutiveStopPause,
  getRecentStopLosses,
  saveRecentStopLosses,
  pruneExpiredCooldowns,
} from '../utils/cooldownStore.js';
import { notify } from '../utils/discord.js';

// ── CONSTANTS ──────────────────────────────────────────────────────────────────
const COOLDOWN_MS                = 45 * 60 * 1000; // 45 minutes per-token cooldown
const CONSECUTIVE_STOP_WINDOW_MS = 30 * 60 * 1000; // 30 minute window
const CONSECUTIVE_STOP_THRESHOLD = 2;               // 2 stops triggers pause
const CONSECUTIVE_STOP_PAUSE_MS  = 90 * 60 * 1000; // 90 minute pause

// ── FAILSAFE 1: SOL PRICE TRACKER ─────────────────────────────────────────────
const solPriceHistory        = [];
const SOL_DROP_THRESHOLD_PCT = 7;
const SOL_PRICE_WINDOW_MS    = 60 * 60 * 1000;

const STRATEGY = 'momentum';

// ── SOL PRICE HELPERS ──────────────────────────────────────────────────────────
function recordSolPrice(price) {
  const now = Date.now();
  solPriceHistory.push({ price, timestamp: now });
  const cutoff = now - SOL_PRICE_WINDOW_MS;
  while (solPriceHistory.length > 0 && solPriceHistory[0].timestamp < cutoff) {
    solPriceHistory.shift();
  }
}

function isSolDropping() {
  if (solPriceHistory.length < 2) return false;
  const oldest  = solPriceHistory[0].price;
  const newest  = solPriceHistory[solPriceHistory.length - 1].price;
  const dropPct = ((oldest - newest) / oldest) * 100;
  if (dropPct >= SOL_DROP_THRESHOLD_PCT) {
    log('warn', `[MOMENTUM] ⚠ FAILSAFE 1: SOL dropped ${dropPct.toFixed(2)}% in the last hour. Pausing entries.`);
    return true;
  }
  return false;
}

// ── CONSECUTIVE STOP LOSS HELPERS (persistent) ────────────────────────────────
function isConsecutiveStopPauseActive() {
  const pauseUntil = getConsecutiveStopPauseUntil();
  if (!pauseUntil) return false;

  if (Date.now() < pauseUntil) {
    const minsLeft = Math.ceil((pauseUntil - Date.now()) / 60000);
    log('warn', `[MOMENTUM] ⚠ FAILSAFE 2: Consecutive stop loss pause active (${minsLeft}m remaining). Skipping all entries.`);
    return true;
  }

  // Pause expired — clear it from disk
  clearConsecutiveStopPause();
  return false;
}

function recordStopLossForConsecutiveCheck() {
  const now = Date.now();

  // Load from disk, trim old entries, add new one
  let recentStops = getRecentStopLosses();
  recentStops.push(now);

  const cutoff = now - CONSECUTIVE_STOP_WINDOW_MS;
  recentStops = recentStops.filter(ts => ts >= cutoff);

  // Check if threshold is hit
  if (recentStops.length >= CONSECUTIVE_STOP_THRESHOLD) {
    const pauseUntil = now + CONSECUTIVE_STOP_PAUSE_MS;
    setConsecutiveStopPause(pauseUntil); // saves to disk + clears recentStops
    log('warn', `[MOMENTUM] 🔴 FAILSAFE 2 TRIGGERED: ${recentStops.length} stop losses in 30 minutes. Pausing momentum entries for 90 minutes.`);
  } else {
    saveRecentStopLosses(recentStops); // save updated list
  }
}

// ── MAIN MONITOR ───────────────────────────────────────────────────────────────
export async function monitorMomentumOpportunities() {
  const settings = loadSettings();
  if (!settings.momentum_enabled) return;

  // Prune expired per-token cooldowns on each scan (keeps file tidy)
  pruneExpiredCooldowns(COOLDOWN_MS);

  // Run market guard check
  await runMarketGuardCheck();
  if (isMarketDangerous()) {
    log('warn', `[MOMENTUM] 🛡 Market guard active (${getAlertLevel()}). Skipping all entries.`);
    return;
  }

  log('info', '[MOMENTUM] Scanning for graduation/momentum tokens...');

  if (isDailyLossLimitReached(settings.daily_loss_limit_sol)) {
    log('warn', '[MOMENTUM] Daily loss limit reached. Pausing.');
    return;
  }

  const balance = await getWalletBalance();
  if (balance < settings.momentum_trade_amount_sol) {
    log('warn', `[MOMENTUM] Insufficient balance: ${balance} SOL`);
    return;
  }

  // ── FAILSAFE 2 CHECK (reads from disk — survives restarts) ────────────────
  if (isConsecutiveStopPauseActive()) return;

  let tokens;
  try {
    tokens = await fetchTopSolanaTokens();
  } catch (err) {
    log('error', `[MOMENTUM] DexScreener fetch failed: ${err.message}`);
    return;
  }

  // ── FAILSAFE 1 CHECK ──────────────────────────────────────────────────────
  const solToken = tokens.find(t => t.symbol === 'SOL' || t.symbol === 'WSOL');
  if (solToken) recordSolPrice(solToken.price_usd);

  if (isSolDropping()) {
    log('warn', '[MOMENTUM] Skipping all entries due to SOL price drop failsafe.');
    return;
  }

  for (const token of tokens) {
    try {
      await evaluateMomentumToken(token, settings);
    } catch (err) {
      log('error', `[MOMENTUM] Error evaluating ${token.symbol}: ${err.message}`);
    }
  }
}

// ── TOKEN EVALUATION ───────────────────────────────────────────────────────────
async function evaluateMomentumToken(token, settings) {
  const {
    momentum_entry_mc_min,
    momentum_entry_mc_max,
    momentum_volume_multiplier,
    momentum_volume_multiplier_max,
  } = settings;

  // 1. MC range check
  if (token.market_cap < momentum_entry_mc_min || token.market_cap > momentum_entry_mc_max) return;

  // 2. No duplicate trades
  if (hasActiveTradeForToken(token.address, STRATEGY)) return;

  // 3. Cooldown check — reads from disk, survives restarts
  const lastStopLoss = getStopLossCooldown(token.address);
  if (lastStopLoss && Date.now() - lastStopLoss < COOLDOWN_MS) {
    const minsLeft = Math.ceil((COOLDOWN_MS - (Date.now() - lastStopLoss)) / 60000);
    log('info', `[MOMENTUM] ${token.symbol} — cooldown active (${minsLeft}m remaining). Skip.`);
    return;
  }

  // 4. Volume momentum check — min 5x (data: <5x = 0% win rate), max 12x (>12x = token likely peaked)
  const hourlyAvg     = token.volume_24h / 24;
  const volMultiplier = hourlyAvg > 0 ? token.volume_1h / hourlyAvg : 0;
  if (volMultiplier < momentum_volume_multiplier) return;
  if (volMultiplier > momentum_volume_multiplier_max) {
    log('info', `[MOMENTUM] ${token.symbol} — Vol ${volMultiplier.toFixed(1)}x exceeds cap (${momentum_volume_multiplier_max}x). Token likely peaked. Skip.`);
    return;
  }

  // 5. Buy pressure check
  if (token.buy_pressure < 55) return;

  // 6. Liquidity check
  if (token.liquidity_usd < settings.min_liquidity_usd) return;

  // 7. Honeypot check
  if (settings.honeypot_check_enabled) {
    const hp = basicHoneypotCheck(token);
    if (!hp.safe) {
      log('warn', `[MOMENTUM] ${token.symbol} — ${hp.flag}. Skip.`);
      return;
    }
  }

  // 8. Quality check — lowered to 55 (Q score has weak predictive value; vol filter now does the heavy lifting)
  const quality = evaluateTokenQuality(token, settings);
  log('info', `[MOMENTUM] ${token.symbol} — MC: $${(token.market_cap/1000).toFixed(0)}K | Vol ${volMultiplier.toFixed(1)}x | Buy: ${token.buy_pressure.toFixed(0)}% | Q: ${quality.score}`);
  if (quality.score < 55) return;

  await executeMomentumBuy(token, settings, volMultiplier, quality.score);
}

// ── EXECUTE BUY ────────────────────────────────────────────────────────────────
async function executeMomentumBuy(token, settings, volMultiplier, qualityScore) {
  const walletAddress = getWalletAddress();
  const slippageBps   = calculateSlippage(
    settings.momentum_trade_amount_sol,
    token.liquidity_usd,
    150,
    token.price_change_5m
  );

  log('info', `[MOMENTUM] Entering ${token.symbol} — ${settings.momentum_trade_amount_sol} SOL | Vol: ${volMultiplier.toFixed(1)}x | slippage: ${slippageBps}bps`);

  try {
    const { swapTx, quote } = await buildBuyTransaction(
      token.address,
      settings.momentum_trade_amount_sol,
      slippageBps,
      walletAddress
    );

    const sig = await signAndSendTransaction(swapTx);

    createTrade({
      strategy:            STRATEGY,
      token_symbol:        token.symbol,
      token_address:       token.address,
      entry_price:         token.price_usd,
      entry_market_cap:    token.market_cap,
      amount_sol:          settings.momentum_trade_amount_sol,
      token_amount:        parseInt(quote.outAmount),
      target_gain_percent: settings.target_gain_percent,
      stop_loss_percent:   settings.momentum_stop_loss_percent,
      exit_mc_min:         settings.momentum_exit_mc_min,
      exit_mc_max:         settings.momentum_exit_mc_max,
      tx_signature_entry:  sig,
      quality_score:       qualityScore,
      vol_multiplier:      volMultiplier,
      slippage_bps:        slippageBps,
    });

    log('info', `[MOMENTUM] ✅ Entered ${token.symbol} | Tx: ${sig}`);
    await notify.tradeOpen({ strategy: STRATEGY, token_symbol: token.symbol, entry_market_cap: token.market_cap, amount_sol: settings.momentum_trade_amount_sol, quality_score: qualityScore, vol_multiplier: volMultiplier, exit_mc_min: settings.momentum_exit_mc_min });
  } catch (err) {
    log('error', `[MOMENTUM] Buy failed for ${token.symbol}: ${err.message}`);
  }
}

// ── EXPORTED STOP LOSS RECORDER ────────────────────────────────────────────────
export function recordMomentumStopLoss(tokenAddress) {
  setStopLossCooldown(tokenAddress);
  recordStopLossForConsecutiveCheck();
}
