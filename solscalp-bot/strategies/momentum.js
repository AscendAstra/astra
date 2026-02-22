/**
 * Strategy 2: Momentum / Pump.fun Graduation Sniper
 * Entry: $100K–$150K MC + 2x volume momentum
 * Exit: $250K–$300K MC
 * Stop Loss: -20%
 */

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

const STRATEGY = 'momentum';

export async function monitorMomentumOpportunities() {
  const settings = loadSettings();
  if (!settings.momentum_enabled) return;

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

  let tokens;
  try {
    tokens = await fetchTopSolanaTokens();
  } catch (err) {
    log('error', `[MOMENTUM] DexScreener fetch failed: ${err.message}`);
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

async function evaluateMomentumToken(token, settings) {
  const {
    momentum_entry_mc_min,
    momentum_entry_mc_max,
    momentum_volume_multiplier,
  } = settings;

  // 1. MC range check
  if (token.market_cap < momentum_entry_mc_min || token.market_cap > momentum_entry_mc_max) return;

  // 2. No duplicate trades
  if (hasActiveTradeForToken(token.address, STRATEGY)) return;

  // 3. Volume momentum check (recent volume must be 2x+ average)
  // Compare 1h volume to expected average from 24h (24h/24 = hourly avg)
  const hourlyAvg = token.volume_24h / 24;
  const volMultiplier = hourlyAvg > 0 ? token.volume_1h / hourlyAvg : 0;

  if (volMultiplier < momentum_volume_multiplier) {
    return; // Not enough volume momentum
  }

  // 4. Buy pressure check
  if (token.buy_pressure < 55) return;

  // 5. Liquidity check
  if (token.liquidity_usd < settings.min_liquidity_usd) return;

  // 6. Honeypot check
  if (settings.honeypot_check_enabled) {
    const hp = basicHoneypotCheck(token);
    if (!hp.safe) {
      log('warn', `[MOMENTUM] ${token.symbol} — ${hp.flag}. Skip.`);
      return;
    }
  }

  // 7. Quality check
  const quality = evaluateTokenQuality(token, settings);

  log('info', `[MOMENTUM] ${token.symbol} — MC: $${(token.market_cap/1000).toFixed(0)}K | Vol ${volMultiplier.toFixed(1)}x | Buy: ${token.buy_pressure.toFixed(0)}% | Q: ${quality.score}`);

  if (quality.score < 45) return;

  await executeMomentumBuy(token, settings, volMultiplier, quality.score);
}

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
      strategy:              STRATEGY,
      token_symbol:          token.symbol,
      token_address:         token.address,
      entry_price:           token.price_usd,
      entry_market_cap:      token.market_cap,
      amount_sol:            settings.momentum_trade_amount_sol,
      token_amount:          parseInt(quote.outAmount),
      target_gain_percent:   settings.target_gain_percent,
      stop_loss_percent:     settings.momentum_stop_loss_percent,
      exit_mc_min:           settings.momentum_exit_mc_min,
      exit_mc_max:           settings.momentum_exit_mc_max,
      tx_signature_entry:    sig,
      quality_score:         qualityScore,
      vol_multiplier:        volMultiplier,
      slippage_bps:          slippageBps,
    });

    log('info', `[MOMENTUM] ✅ Entered ${token.symbol} | Tx: ${sig}`);
  } catch (err) {
    log('error', `[MOMENTUM] Buy failed for ${token.symbol}: ${err.message}`);
  }
}
