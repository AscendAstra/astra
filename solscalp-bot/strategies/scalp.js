/**
 * Strategy 1: High-Volume Scalp Bot
 * Entry: $350K MC ± 20% ($280K–$420K)
 * Exit: $800K MC (80% at 70% profit, rest at 100%)
 * Stop Loss: -20%
 */
import { isMarketDangerous, getAlertLevel } from '../utils/marketGuard.js';
import { fetchTopSolanaTokens } from '../dexscreener/index.js';
import { computeHealthScore, basicHoneypotCheck } from '../analysis/scoring.js';
import { buildBuyTransaction, buildSellTransaction, calculateSlippage } from '../jupiter/index.js';
import { signAndSendTransaction, getWalletAddress, getWalletBalance } from '../wallet/custodial.js';
import {
  createTrade,
  updateTrade,
  hasActiveTradeForToken,
  isDailyLossLimitReached,
} from '../store/trades.js';
import { loadSettings } from '../config/settings.js';
import { log } from '../utils/logger.js';

const STRATEGY = 'scalp';

// Missed opportunity tracking
const monitorCounts = new Map(); // address → { count, symbol, firstMC, firstSeen }
const MONITOR_ALERT_THRESHOLD = 5; // scans before we flag it
export async function monitorScalpOpportunities() {
  const settings = loadSettings();
  if (!settings.scalp_enabled) return;
 if (isMarketDangerous()) {
    log('warn', `[SCALP] 🛡 Market guard active (${getAlertLevel()}). Skipping all entries.`);
    return;
  }

  log('info', '[SCALP] Scanning DexScreener for scalp opportunities...');

  if (isDailyLossLimitReached(settings.daily_loss_limit_sol)) {
    log('warn', '[SCALP] Daily loss limit reached. Pausing strategy.');
    return;
  }

  const balance = await getWalletBalance();
  if (balance < settings.scalp_trade_amount_sol) {
    log('warn', `[SCALP] Insufficient balance: ${balance} SOL`);
    return;
  }

  let tokens;
  try {
    tokens = await fetchTopSolanaTokens();
  } catch (err) {
    log('error', `[SCALP] DexScreener fetch failed: ${err.message}`);
    return;
  }

  log('info', `[SCALP] Evaluating ${tokens.length} tokens...`);

  for (const token of tokens) {
    try {
      await evaluateScalpToken(token, settings);
    } catch (err) {
      log('error', `[SCALP] Error evaluating ${token.symbol}: ${err.message}`);
    }
  }
}

async function evaluateScalpToken(token, settings) {
  const { scalp_entry_mc_min, scalp_entry_mc_max } = settings;

  // 1. MC range check
  if (token.market_cap < scalp_entry_mc_min || token.market_cap > scalp_entry_mc_max) return;

  // 2. No duplicate trades (scalp = 1 trade per token)
  if (hasActiveTradeForToken(token.address, STRATEGY)) return;

  // 3. Liquidity minimum
  if (token.liquidity_usd < settings.min_liquidity_usd) {
    log('info', `[SCALP] ${token.symbol} — Low liquidity ($${token.liquidity_usd.toFixed(0)}). Skip.`);
    return;
  }

  // 4. Honeypot check
  if (settings.honeypot_check_enabled) {
    const hp = basicHoneypotCheck(token);
    if (!hp.safe) {
      log('warn', `[SCALP] ${token.symbol} — ${hp.flag}. Skip.`);
      return;
    }
  }

  // 5. Health / PUNCH score
  const skipPunch = !settings.scalp_punch_check_enabled;
  const health    = computeHealthScore(token, settings, skipPunch);

  log('info', `[SCALP] ${token.symbol} — MC: $${(token.market_cap/1000).toFixed(0)}K | Health: ${health.health_score} | ${health.recommendation} | Flags: ${health.flags.join(', ') || 'none'}`);

  if (!health.should_trade) {
    // Track how long this token sits in MONITOR
    if (health.recommendation === 'MONITOR') {
      const existing = monitorCounts.get(token.address);
      if (!existing) {
        monitorCounts.set(token.address, {
          count: 1,
          symbol: token.symbol,
          firstMC: token.market_cap,
          firstSeen: new Date().toISOString(),
          flags: health.flags
        });
      } else {
        existing.count++;
        existing.latestMC = token.market_cap;
        existing.latestFlags = health.flags;
        if (existing.count === MONITOR_ALERT_THRESHOLD) {
          log('warn', `[SCALP] [MISSED?] ${token.symbol} — stuck in MONITOR for ${existing.count} scans | Entry MC: $${(existing.firstMC/1000).toFixed(0)}K → Now: $${(token.market_cap/1000).toFixed(0)}K | Flags: ${health.flags.join(', ') || 'none'}`);
        }
      }
    }
    return;
  }

  // Clear monitor tracking if it eventually executes
  if (monitorCounts.has(token.address)) {
    const tracked = monitorCounts.get(token.address);
    if (tracked.count >= MONITOR_ALERT_THRESHOLD) {
      log('info', `[SCALP] [MONITOR→EXECUTE] ${token.symbol} — cleared after ${tracked.count} scans | Was stuck at: $${(tracked.firstMC/1000).toFixed(0)}K`);
    }
    monitorCounts.delete(token.address);
  }
  // 6. Execute buy
  await executeScalpBuy(token, settings, health);
}

async function executeScalpBuy(token, settings, health) {
  const walletAddress = getWalletAddress();
  const slippageBps   = calculateSlippage(
    settings.scalp_trade_amount_sol,
    token.liquidity_usd,
    150,
    token.price_change_5m
  );

  log('info', `[SCALP] Entering ${token.symbol} — ${settings.scalp_trade_amount_sol} SOL, slippage: ${slippageBps}bps`);

  try {
    const { swapTx, quote } = await buildBuyTransaction(
      token.address,
      settings.scalp_trade_amount_sol,
      slippageBps,
      walletAddress
    );

    const sig = await signAndSendTransaction(swapTx);
    const tokenAmount = parseInt(quote.outAmount);

    createTrade({
      strategy:             STRATEGY,
      token_symbol:         token.symbol,
      token_address:        token.address,
      entry_price:          token.price_usd,
      entry_market_cap:     token.market_cap,
      amount_sol:           settings.scalp_trade_amount_sol,
      token_amount:         tokenAmount,
      target_gain_percent:  70,   // partial exit at 70%
      stop_loss_percent:    settings.scalp_stop_loss_percent,
      tx_signature_entry:   sig,
      health_score:         health.health_score,
      slippage_bps:         slippageBps,
    });

    log('info', `[SCALP] ✅ Entered ${token.symbol} | Tx: ${sig}`);
  } catch (err) {
    log('error', `[SCALP] Buy failed for ${token.symbol}: ${err.message}`);
  }
}
