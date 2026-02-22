/**
 * Strategy 3: Breakout Strategy
 * Entry: $5M–$20M MC + 2x volume + 10%+ 5m pump + 55%+ buy pressure
 * Exit: 30% target gain OR sell pressure detected
 * Stop Loss: -20%
 * Note: Can trade same token multiple times
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

const STRATEGY = 'breakout';

export async function monitorBreakoutOpportunities() {
  const settings = loadSettings();
  if (!settings.breakout_enabled) return;

  log('info', '[BREAKOUT] Scanning for breakout opportunities...');

  if (isDailyLossLimitReached(settings.daily_loss_limit_sol)) {
    log('warn', '[BREAKOUT] Daily loss limit reached. Pausing.');
    return;
  }

  const balance = await getWalletBalance();
  if (balance < settings.breakout_trade_amount_sol) {
    log('warn', `[BREAKOUT] Insufficient balance: ${balance} SOL`);
    return;
  }

  let tokens;
  try {
    tokens = await fetchTopSolanaTokens();
  } catch (err) {
    log('error', `[BREAKOUT] DexScreener fetch failed: ${err.message}`);
    return;
  }

  for (const token of tokens) {
    try {
      await evaluateBreakoutToken(token, settings);
    } catch (err) {
      log('error', `[BREAKOUT] Error evaluating ${token.symbol}: ${err.message}`);
    }
  }
}

async function evaluateBreakoutToken(token, settings) {
  const {
    breakout_entry_mc_min,
    breakout_entry_mc_max,
    breakout_volume_multiplier,
    breakout_min_5m_pump,
    breakout_min_buy_pressure,
    breakout_allow_repeat_trades,
  } = settings;

  // 1. MC range check ($5M–$20M)
  if (token.market_cap < breakout_entry_mc_min || token.market_cap > breakout_entry_mc_max) return;

  // 2. Repeat trade check (breakout allows repeat trades on same token)
  if (!breakout_allow_repeat_trades && hasActiveTradeForToken(token.address, STRATEGY)) return;
  if (breakout_allow_repeat_trades  && hasActiveTradeForToken(token.address, STRATEGY)) return; // still skip if one already active

  // 3. 5m price pump check (must be pumping NOW)
  if (token.price_change_5m < breakout_min_5m_pump) return;

  // 4. Buy pressure check (55%+)
  if (token.buy_pressure < breakout_min_buy_pressure) return;

  // 5. Volume momentum check (2x+ hourly average)
  const hourlyAvg    = token.volume_24h / 24;
  const volMultiplier = hourlyAvg > 0 ? token.volume_1h / hourlyAvg : 0;
  if (volMultiplier < breakout_volume_multiplier) return;

  // 6. Liquidity check
  if (token.liquidity_usd < settings.min_liquidity_usd) return;

  // 7. Honeypot check
  if (settings.honeypot_check_enabled) {
    const hp = basicHoneypotCheck(token);
    if (!hp.safe) {
      log('warn', `[BREAKOUT] ${token.symbol} — ${hp.flag}. Skip.`);
      return;
    }
  }

  log('info', `[BREAKOUT] 🚀 Signal: ${token.symbol} — MC: $${(token.market_cap/1000000).toFixed(1)}M | 5m: +${token.price_change_5m.toFixed(1)}% | Vol: ${volMultiplier.toFixed(1)}x | Buy: ${token.buy_pressure.toFixed(0)}%`);

  await executeBreakoutBuy(token, settings, volMultiplier);
}

async function executeBreakoutBuy(token, settings, volMultiplier) {
  const walletAddress = getWalletAddress();

  // For breakout, use slightly higher slippage given volatility
  const slippageBps = Math.max(
    200,
    calculateSlippage(
      settings.breakout_trade_amount_sol,
      token.liquidity_usd,
      150,
      token.price_change_5m
    )
  );

  log('info', `[BREAKOUT] Entering ${token.symbol} — ${settings.breakout_trade_amount_sol} SOL | slippage: ${slippageBps}bps`);

  try {
    const { swapTx, quote } = await buildBuyTransaction(
      token.address,
      settings.breakout_trade_amount_sol,
      slippageBps,
      walletAddress
    );

    const sig = await signAndSendTransaction(swapTx);

    createTrade({
      strategy:             STRATEGY,
      token_symbol:         token.symbol,
      token_address:        token.address,
      entry_price:          token.price_usd,
      entry_market_cap:     token.market_cap,
      amount_sol:           settings.breakout_trade_amount_sol,
      token_amount:         parseInt(quote.outAmount),
      target_gain_percent:  settings.breakout_target_gain_percent,
      stop_loss_percent:    settings.breakout_stop_loss_percent,
      tx_signature_entry:   sig,
      vol_multiplier:       volMultiplier,
      pump_5m:              token.price_change_5m,
      buy_pressure_entry:   token.buy_pressure,
      slippage_bps:         slippageBps,
    });

    log('info', `[BREAKOUT] ✅ Entered ${token.symbol} | Tx: ${sig}`);
  } catch (err) {
    log('error', `[BREAKOUT] Buy failed for ${token.symbol}: ${err.message}`);
  }
}
