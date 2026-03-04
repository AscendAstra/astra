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
import { signAndSendTransaction, getWalletAddress, getWalletBalance, getTokenBalance } from '../wallet/custodial.js';
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
  pruneExpiredCooldowns,
  isConsecutiveStopPauseActive,
  recordStopLossForConsecutiveCheck,
  getEntryCount,
  recordEntry,
} from '../utils/cooldownStore.js';
import { notify } from '../utils/discord.js';
import { checkHolderConcentration } from '../analysis/holderCheck.js';
import { isTokenBlocked } from '../utils/contentFilter.js';

// ── CONSTANTS ──────────────────────────────────────────────────────────────────
const COOLDOWN_MS = 45 * 60 * 1000; // 45 minutes per-token cooldown

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

  // 0. Content filter — block offensive tokens
  if (isTokenBlocked(token.symbol, token.name, settings)) return;

  // 0b. UTC time block — data: 12-15 & 18-21 UTC = 19% WR combined, -0.643 SOL
  const blockRanges = (settings.momentum_block_utc_ranges || '12-15,18-21')
    .split(',')
    .map(r => r.trim().split('-').map(Number));
  const utcHour = new Date().getUTCHours();
  for (const [start, end] of blockRanges) {
    if (utcHour >= start && utcHour < end) {
      log('info', `[MOMENTUM] UTC block active (${utcHour}:00 UTC in ${start}-${end} window). Skip.`);
      return;
    }
  }

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

  // 3.5. Re-entry limit: max 1 entry per token per 24h (data: re-entries 19% WR, -0.330 SOL)
  const entryCount = getEntryCount(token.address, 24 * 60 * 60 * 1000, STRATEGY);
  if (entryCount >= 1) {
    log('info', `[MOMENTUM] ${token.symbol} — max entries reached (${entryCount}/1 in 24h). Skip.`);
    return;
  }

  // 3.6. On re-entry (2nd attempt), check holder concentration
  if (entryCount >= 1 && settings.whale_tracking_enabled) {
    const holders = await checkHolderConcentration(token.address);
    if (holders.is_concentrated) {
      log('warn', `[MOMENTUM] ${token.symbol} — whale concentrated (top 10 hold ${holders.top10_percent.toFixed(0)}%). Skip re-entry.`);
      return;
    }
  }

  // 4. 5m momentum gate — data: negative 5m entries = 35% WR (-0.11 SOL), positive = 48% WR (+0.18 SOL)
  if (token.price_change_5m != null && token.price_change_5m < settings.momentum_min_5m_pump) {
    log('info', `[MOMENTUM] ${token.symbol} — 5m pump ${token.price_change_5m.toFixed(1)}% below min (${settings.momentum_min_5m_pump}%). Skip.`);
    return;
  }

  // 4b. 1h pump cap — data: 1h >30% = 38% WR (-0.21 SOL), buying tops
  if (token.price_change_1h != null && token.price_change_1h > settings.momentum_max_1h_pump) {
    log('info', `[MOMENTUM] ${token.symbol} — 1h pump +${token.price_change_1h.toFixed(0)}% exceeds cap (${settings.momentum_max_1h_pump}%). Skip.`);
    return;
  }

  // 5. Volume momentum check — min 9x (data: 9-12x = 58% WR, 5-9x = 33% WR), max 12x (>12x = token likely peaked)
  const hourlyAvg     = token.volume_24h / 24;
  const volMultiplier = hourlyAvg > 0 ? token.volume_1h / hourlyAvg : 0;
  if (volMultiplier < momentum_volume_multiplier) return;
  if (volMultiplier > momentum_volume_multiplier_max) {
    log('info', `[MOMENTUM] ${token.symbol} — Vol ${volMultiplier.toFixed(1)}x exceeds cap (${momentum_volume_multiplier_max}x). Token likely peaked. Skip.`);
    return;
  }

  // 6. Buy pressure check
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
    const balanceBefore = await getWalletBalance();

    const { swapTx, quote } = await buildBuyTransaction(
      token.address,
      settings.momentum_trade_amount_sol,
      slippageBps,
      walletAddress
    );

    const sig = await signAndSendTransaction(swapTx);

    // Verify tokens actually received (skip in paper mode)
    const receivedBalance = await getTokenBalance(token.address);
    if (receivedBalance !== null && receivedBalance === 0) {
      log('error', `[MOMENTUM] Buy tx ${sig} confirmed but no tokens received. Skipping trade creation.`);
      return;
    }

    const balanceAfter = await getWalletBalance();
    const sol_spent = balanceBefore - balanceAfter;

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
      buy_pressure_entry:  token.buy_pressure,
      pump_1h:             token.price_change_1h,
      pump_5m:             token.price_change_5m,
      price_change_24h:    token.price_change_24h,
      sol_spent,
      entry_balance_before: balanceBefore,
    });

    recordEntry(token.address, STRATEGY);
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
