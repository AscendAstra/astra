/**
 * Active Trade Monitor
 * Runs every 60s — checks all active trades for exit conditions
 *
 * Exit logic:
 * SCALP:     70% profit → sell 80% | 100% profit → sell remaining | -20% → stop loss
 * MOMENTUM:  MC reaches $250K–$300K → sell | -20% → stop loss
 * BREAKOUT:  30% profit OR sell pressure detected → sell | -20% → stop loss
 */
import { isRedAlert, isOrangeOrAbove } from '../utils/marketGuard.js';
import { fetchTokenData } from '../dexscreener/index.js';
import { buildSellTransaction, calculateSlippage } from '../jupiter/index.js';
import { signAndSendTransaction, getWalletAddress } from '../wallet/custodial.js';
import {
  getActiveTrades,
  updateTrade,
  closeTrade,
} from '../store/trades.js';
import { loadSettings } from '../config/settings.js';
import { log } from '../utils/logger.js';
import { recordMomentumStopLoss } from '../strategies/momentum.js';
import { recordBreakoutExit } from '../strategies/breakout.js';
import { recordScalpStopLoss } from '../strategies/scalp.js';
import { recordPumpfunStopLoss } from '../strategies/pumpfun.js';
import { recordMidcapStopLoss } from '../strategies/midcap.js';
import { notify } from '../utils/discord.js';

// ── SELL RACE GUARD ─────────────────────────────────────────────────────────
// Prevents activeTrades (60s) and fastStopLoss (10s) from selling the same
// trade simultaneously. Same pattern as pumpfun.js pendingSells.
const pendingSells = new Set(); // tradeId

// ── SELL FAILURE TRACKING ────────────────────────────────────────────────────
// After MAX_SELL_FAILURES consecutive failures, force close the trade.
// Prevents infinite retry loops on dead/drained tokens.
const sellFailures = new Map(); // tradeId → count
const MAX_SELL_FAILURES = 3;

export async function monitorActiveTrades() {
  const settings  = loadSettings();
  const active    = getActiveTrades();

  if (active.length === 0) return;

  log('info', `[MONITOR] Checking ${active.length} active trade(s)...`);

  for (const trade of active) {
    try {
      await checkTradeExit(trade, settings);
    } catch (err) {
      log('error', `[MONITOR] Error checking ${trade.token_symbol}: ${err.message}`);
    }
  }
}

async function checkTradeExit(trade, settings) {
  // Fetch latest token data
  const token = await fetchTokenData(trade.token_address);
  if (!token) {
    log('warn', `[MONITOR] No data for ${trade.token_symbol} (${trade.token_address})`);
    return;
  }

  const currentPrice = token.price_usd;
  const pnlPercent   = ((currentPrice - trade.entry_price) / trade.entry_price) * 100;

  // Update highest price for trailing stop
  if (currentPrice > (trade.highest_price || trade.entry_price)) {
    updateTrade(trade.id, { highest_price: currentPrice, pnl_percent: pnlPercent });
  } else {
    updateTrade(trade.id, { pnl_percent: pnlPercent });
  }

  log('info', `[MONITOR] ${trade.token_symbol} (${trade.strategy}) — P&L: ${pnlPercent.toFixed(2)}% | MC: $${(token.market_cap/1000).toFixed(0)}K`);
 // ── MARKET GUARD: RED ALERT — close momentum positions immediately ──────────
  if (isRedAlert() && trade.strategy === 'momentum') {
    log('warn', `[MONITOR] 🔴 RED ALERT — Force closing momentum position: ${trade.token_symbol}`);
    await executeSell(trade, token, settings, 'market_guard_red', 100);
    return;
  }

  // ── MARKET GUARD: ORANGE ALERT — tighten stop losses ──────────────────────
  if (isOrangeOrAbove() && trade.strategy === 'momentum') {
    const tightenedStop = (trade.stop_loss_percent || settings.stop_loss_percent) * 0.5;
    const tightenedPnl  = -(tightenedStop);
    if (pnlPercent <= tightenedPnl) {
      log('warn', `[MONITOR] 🟠 ORANGE ALERT — Tightened stop hit for ${trade.token_symbol} (${pnlPercent.toFixed(2)}%). Selling.`);
      if (trade.strategy === 'momentum') recordMomentumStopLoss(trade.token_address);
      await executeSell(trade, token, settings, 'market_guard_orange', 100);
      return;
    }
  }


  // ── TRAILING STOP ──────────────────────────────────────────────────────────
  if (settings.trailing_stop_enabled && trade.highest_price) {
    const dropFromHigh = ((currentPrice - trade.highest_price) / trade.highest_price) * 100;
    if (dropFromHigh <= -settings.trailing_stop_percent && pnlPercent > 0) {
      log('info', `[MONITOR] ${trade.token_symbol} — Trailing stop hit (${dropFromHigh.toFixed(2)}% from high). Selling.`);
      await executeSell(trade, token, settings, 'trailing_stop', 100);
      return;
    }
  }

  // ── STOP LOSS ──────────────────────────────────────────────────────────────
  const stopLoss = -(trade.stop_loss_percent || settings.stop_loss_percent);
  if (pnlPercent <= stopLoss) {
    log('warn', `[MONITOR] ${trade.token_symbol} — Stop loss hit (${pnlPercent.toFixed(2)}%). Selling.`);
    if (trade.strategy === 'momentum') recordMomentumStopLoss(trade.token_address);
    if (trade.strategy === 'scalp') recordScalpStopLoss(trade.token_address);
    if (trade.strategy === 'breakout') recordBreakoutExit(trade.token_address);
    if (trade.strategy === 'pumpfun') recordPumpfunStopLoss(trade.token_address);
    if (trade.strategy === 'midcap') recordMidcapStopLoss(trade.token_address);
    await executeSell(trade, token, settings, 'stop_loss', 100);
    return;
  }

  // ── STALE TRADE EXIT ──────────────────────────────────────────────────────
  // Momentum/scalp/midcap trades open > 90min with P&L between stop loss and +5% are dead money.
  // Close at market to free the trade slot. Breakout excluded (mid-caps consolidate longer).
  if ((trade.strategy === 'momentum' || trade.strategy === 'scalp' || trade.strategy === 'pumpfun' || trade.strategy === 'midcap') && settings.stale_trade_timeout_ms > 0) {
    const tradeAgeMs = Date.now() - new Date(trade.entry_time).getTime();
    const staleLowerBound = -(trade.stop_loss_percent || settings.stop_loss_percent);
    if (tradeAgeMs > settings.stale_trade_timeout_ms && pnlPercent > staleLowerBound && pnlPercent < 5) {
      const ageMins = Math.round(tradeAgeMs / 60000);
      log('info', `[MONITOR] ${trade.token_symbol} (${trade.strategy}) — Stale trade exit: ${ageMins}m open, P&L ${pnlPercent.toFixed(1)}%. Closing.`);
      await executeSell(trade, token, settings, 'stale_exit', 100);
      return;
    }
  }

  // ── STRATEGY-SPECIFIC EXITS ────────────────────────────────────────────────
  switch (trade.strategy) {
    case 'scalp':
      await checkScalpExit(trade, token, pnlPercent, settings);
      break;
    case 'momentum':
      await checkMomentumExit(trade, token, pnlPercent, settings);
      break;
    case 'breakout':
      await checkBreakoutExit(trade, token, pnlPercent, settings);
      break;
    case 'pumpfun':
      await checkPumpfunExit(trade, token, pnlPercent, settings);
      break;
    case 'midcap':
      await checkMidcapExit(trade, token, pnlPercent, settings);
      break;
  }
}

// SCALP: 70% profit → sell 80% | 100% profit → sell remaining 20%
async function checkScalpExit(trade, token, pnlPercent, settings) {
  if (!trade.partial_exit_executed && pnlPercent >= (trade.target_gain_percent || 70)) {
    log('info', `[SCALP] ${trade.token_symbol} — +${pnlPercent.toFixed(1)}% hit. Partial exit (80%).`);
    await executeSell(trade, token, settings, 'partial_target', 80);
    return;
  }

  if (trade.partial_exit_executed && pnlPercent >= 100) {
    log('info', `[SCALP] ${trade.token_symbol} — +${pnlPercent.toFixed(1)}% hit. Final exit (20%).`);
    await executeSell(trade, token, settings, 'final_target', 100);
    return;
  }

  // Also exit if MC has reached target ($800K)
 if (token.market_cap >= settings.scalp_exit_mc) {
    const sellPct = trade.partial_exit_executed ? 100 : 80;
    log('info', `[SCALP] ${trade.token_symbol} — MC target $${(settings.scalp_exit_mc/1000).toFixed(0)}K reached. Selling ${sellPct}%.`);
    await executeSell(trade, token, settings, 'mc_target', sellPct);
    return;
  }

  // Sell pressure detection (buy pressure drops while in profit)
  if (settings.scalp_sell_pressure_enabled
      && token.buy_pressure < settings.scalp_sell_pressure_threshold
      && pnlPercent > 0) {
    log('info', `[SCALP] ${trade.token_symbol} — Sell pressure detected (${token.buy_pressure.toFixed(0)}% buys). Exiting at +${pnlPercent.toFixed(1)}%.`);
    await executeSell(trade, token, settings, 'sell_pressure', 100);
  }
}

// MOMENTUM: Profit target → MC target → sell pressure
async function checkMomentumExit(trade, token, pnlPercent, settings) {
  // Profit target — auto-sell at +25% (data: 11 trades saw +30%+ then reversed to losses)
  const profitTarget = settings.momentum_target_gain_percent || 25;
  if (pnlPercent >= profitTarget) {
    log('info', `[MOMENTUM] ${trade.token_symbol} — +${pnlPercent.toFixed(1)}% profit target hit. Selling.`);
    await executeSell(trade, token, settings, 'target', 100);
    return;
  }

  const exitMcMin = trade.exit_mc_min || settings.momentum_exit_mc_min;
  const exitMcMax = trade.exit_mc_max || settings.momentum_exit_mc_max;

  if (token.market_cap >= exitMcMin) {
    log('info', `[MOMENTUM] ${trade.token_symbol} — MC $${(token.market_cap/1000).toFixed(0)}K reached exit zone. Selling.`);
    await executeSell(trade, token, settings, 'mc_target', 100);
    return;
  }

  // Sell pressure detection (buy pressure drops while in profit)
  if (settings.momentum_sell_pressure_enabled
      && token.buy_pressure < settings.momentum_sell_pressure_threshold
      && pnlPercent > 0) {
    log('info', `[MOMENTUM] ${trade.token_symbol} — Sell pressure detected (${token.buy_pressure.toFixed(0)}% buys). Exiting at +${pnlPercent.toFixed(1)}%.`);
    await executeSell(trade, token, settings, 'sell_pressure', 100);
  }
}

// BREAKOUT: 30% gain OR sell pressure detected
async function checkBreakoutExit(trade, token, pnlPercent, settings) {
  // Target gain
  if (pnlPercent >= settings.breakout_target_gain_percent) {
    log('info', `[BREAKOUT] ${trade.token_symbol} — +${pnlPercent.toFixed(1)}% target hit. Selling.`);
    await executeSell(trade, token, settings, 'target', 100);
    return;
  }

  // Sell pressure detection (buy pressure drops while in profit)
  if (settings.breakout_sell_pressure_enabled
      && token.buy_pressure < settings.breakout_sell_pressure_threshold
      && pnlPercent > 0) {
    log('info', `[BREAKOUT] ${trade.token_symbol} — Sell pressure detected (${token.buy_pressure.toFixed(0)}% buys). Exiting at +${pnlPercent.toFixed(1)}%.`);
    await executeSell(trade, token, settings, 'sell_pressure', 100);
  }
}

// PUMPFUN: Fallback exit — mirrors pumpfun.js WebSocket exit logic using DexScreener data.
// Primary exit path is WebSocket-driven (strategies/pumpfun.js checkPositionExits).
// This is a safety net for when the WebSocket drops or misses events.
async function checkPumpfunExit(trade, token, pnlPercent, settings) {
  // Target gain
  if (pnlPercent >= settings.pumpfun_target_gain_pct) {
    log('info', `[PUMPFUN-MONITOR] ${trade.token_symbol} — +${pnlPercent.toFixed(1)}% target hit (fallback). Selling.`);
    await executeSell(trade, token, settings, 'target', 100);
    return;
  }

  // MC ceiling — approaching graduation, sell before migration
  if (token.market_cap >= settings.pumpfun_max_mc) {
    log('info', `[PUMPFUN-MONITOR] ${trade.token_symbol} — MC ceiling $${(token.market_cap / 1000).toFixed(0)}K (fallback). Selling.`);
    await executeSell(trade, token, settings, 'mc_ceiling', 100);
    return;
  }

  // Sell pressure detection
  if (settings.pumpfun_sell_pressure_enabled
      && token.buy_pressure < settings.pumpfun_sell_pressure_threshold
      && pnlPercent > 0) {
    log('info', `[PUMPFUN-MONITOR] ${trade.token_symbol} — Sell pressure (${token.buy_pressure.toFixed(0)}% buys, fallback). Exiting at +${pnlPercent.toFixed(1)}%.`);
    await executeSell(trade, token, settings, 'sell_pressure', 100);
  }
}

// MIDCAP: +30% target OR sell pressure detected
async function checkMidcapExit(trade, token, pnlPercent, settings) {
  // Target gain
  if (pnlPercent >= settings.midcap_target_gain_percent) {
    log('info', `[MIDCAP] ${trade.token_symbol} — +${pnlPercent.toFixed(1)}% target hit. Selling.`);
    await executeSell(trade, token, settings, 'target', 100);
    return;
  }

  // Sell pressure detection (buy pressure drops while in profit)
  if (settings.midcap_sell_pressure_enabled
      && token.buy_pressure < settings.midcap_sell_pressure_threshold
      && pnlPercent > 0) {
    log('info', `[MIDCAP] ${trade.token_symbol} — Sell pressure detected (${token.buy_pressure.toFixed(0)}% buys). Exiting at +${pnlPercent.toFixed(1)}%.`);
    await executeSell(trade, token, settings, 'sell_pressure', 100);
  }
}

// ── EXECUTE SELL ──────────────────────────────────────────────────────────────
export async function executeSell(trade, token, settings, reason, sellPercent) {
  // Race guard — skip if another loop is already selling this trade
  if (pendingSells.has(trade.id)) {
    log('info', `[SELL] ${trade.token_symbol} — sell already in progress, skipping duplicate.`);
    return;
  }
  pendingSells.add(trade.id);

  const walletAddress = getWalletAddress();

  // Calculate how many tokens to sell
  const tokensToSell = reason === 'partial_target'
    ? Math.floor(trade.token_amount * 0.8)
    : trade.token_amount;

  const remainingTokens = trade.token_amount - tokensToSell;

  const slippageBps = calculateSlippage(
    trade.amount_sol * (sellPercent / 100),
    token.liquidity_usd,
    150,
    token.price_change_5m,
    { isSell: true }
  );

  try {
    const { swapTx } = await buildSellTransaction(
      trade.token_address,
      tokensToSell,
      slippageBps,
      walletAddress
    );

    const sig = await signAndSendTransaction(swapTx);

    // Success — clear failure counter + race guard
    sellFailures.delete(trade.id);
    pendingSells.delete(trade.id);

    const pnlPct = ((token.price_usd - trade.entry_price) / trade.entry_price) * 100;
    const pnlSol = trade.amount_sol * (pnlPct / 100);

    if (reason === 'partial_target') {
      updateTrade(trade.id, {
        partial_exit_executed: true,
        token_amount: remainingTokens,
        tx_signature_partial_exit: sig,
      });
      log('info', `[SELL] ${trade.token_symbol} — Partial exit 80% | Tx: ${sig} | ${remainingTokens} tokens remaining`);
      await notify.partialExit(trade, pnlPct, pnlSol * 0.8);
    } else {
      closeTrade(trade.id, token.price_usd, sig, reason);
      if (reason === 'stop_loss' || reason === 'market_guard_red' || reason === 'market_guard_orange') {
        await notify.stopLoss(trade, pnlPct, pnlSol);
      } else {
        await notify.tradeClose(trade, pnlPct, pnlSol, reason);
      }
    }
  } catch (err) {
    pendingSells.delete(trade.id); // unlock on failure
    const failures = (sellFailures.get(trade.id) || 0) + 1;
    sellFailures.set(trade.id, failures);
    log('error', `[SELL] Failed to sell ${trade.token_symbol} (attempt ${failures}/${MAX_SELL_FAILURES}): ${err.message}`);

    // Force close after repeated failures — token is unsellable (liquidity drained)
    if (failures >= MAX_SELL_FAILURES) {
      const pnlPct = ((token.price_usd - trade.entry_price) / trade.entry_price) * 100;
      const pnlSol = trade.amount_sol * (pnlPct / 100);
      log('warn', `[SELL] ⚠ ${trade.token_symbol} unsellable after ${failures} attempts. Force closing at ${pnlPct.toFixed(2)}%.`);
      closeTrade(trade.id, token.price_usd, 'FORCE_CLOSED_UNSELLABLE', 'unsellable');
      sellFailures.delete(trade.id);
      pendingSells.delete(trade.id);
      await notify.stopLoss(trade, pnlPct, pnlSol);
    }
  }
}