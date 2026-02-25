/**
 * Fast Stop Loss Monitor
 * Polls Jupiter Price API v3 every ~10s to catch rapid price drops.
 * The 60s DexScreener monitor remains as fallback.
 *
 * Jupiter Price API v3: https://api.jup.ag/price/v3?ids=token1,token2,...
 * Free tier: 60 req/60s — at 10s intervals we use ~6 req/min.
 */

import { getActiveTrades } from '../store/trades.js';
import { executeSell } from './activeTrades.js';
import { loadSettings } from '../config/settings.js';
import { isRedAlert, isOrangeOrAbove } from '../utils/marketGuard.js';
import { recordMomentumStopLoss } from '../strategies/momentum.js';
import { recordBreakoutExit } from '../strategies/breakout.js';
import { log } from '../utils/logger.js';

const JUPITER_PRICE_API = 'https://api.jup.ag/price/v3';

/**
 * Fetch USD prices for a list of token mints via Jupiter Price API v3.
 * Returns a map of { mint: priceUsd } for tokens that had a price.
 */
async function fetchJupiterPrices(mints) {
  const url = `${JUPITER_PRICE_API}?ids=${mints.join(',')}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'x-api-key': process.env.JUPITER_API_KEY || '',
    },
  });
  if (!res.ok) {
    throw new Error(`Jupiter price API returned ${res.status}`);
  }
  const json = await res.json();
  const prices = {};
  // v3 response: { data: { [mint]: { id, type, price } } }
  if (json.data) {
    for (const [mint, info] of Object.entries(json.data)) {
      if (info && info.price) {
        prices[mint] = parseFloat(info.price);
      }
    }
  }
  return prices;
}

/**
 * Main fast stop loss check — called every ~10s by the FAST_SL loop.
 */
export async function runFastStopLossCheck() {
  const active = getActiveTrades();
  if (active.length === 0) return;

  const settings = loadSettings();
  const mints    = active.map(t => t.token_address);

  let prices;
  try {
    prices = await fetchJupiterPrices(mints);
  } catch (err) {
    log('warn', `[FAST_SL] Jupiter price fetch failed — skipping cycle: ${err.message}`);
    return;
  }

  for (const trade of active) {
    const currentPrice = prices[trade.token_address];
    if (!currentPrice) continue; // no price data for this token

    const pnlPercent = ((currentPrice - trade.entry_price) / trade.entry_price) * 100;

    // ── RED ALERT: force-close momentum positions ─────────────────────────
    if (isRedAlert() && trade.strategy === 'momentum') {
      log('warn', `[FAST_SL] 🔴 RED ALERT — Force closing ${trade.token_symbol} at ${pnlPercent.toFixed(2)}%`);
      await sellWithMinimalToken(trade, currentPrice, settings, 'market_guard_red');
      continue;
    }

    // ── ORANGE ALERT: tightened stop loss for momentum ────────────────────
    if (isOrangeOrAbove() && trade.strategy === 'momentum') {
      const tightenedStop = (trade.stop_loss_percent || settings.stop_loss_percent) * 0.5;
      if (pnlPercent <= -tightenedStop) {
        log('warn', `[FAST_SL] 🟠 ORANGE tightened stop hit for ${trade.token_symbol} (${pnlPercent.toFixed(2)}%)`);
        if (trade.strategy === 'momentum') recordMomentumStopLoss(trade.token_address);
        await sellWithMinimalToken(trade, currentPrice, settings, 'market_guard_orange');
        continue;
      }
    }

    // ── STANDARD STOP LOSS ────────────────────────────────────────────────
    const stopLoss = -(trade.stop_loss_percent || settings.stop_loss_percent);
    if (pnlPercent <= stopLoss) {
      log('warn', `[FAST_SL] ${trade.token_symbol} stop loss hit (${pnlPercent.toFixed(2)}%). Selling immediately.`);
      if (trade.strategy === 'momentum') recordMomentumStopLoss(trade.token_address);
      if (trade.strategy === 'breakout') recordBreakoutExit(trade.token_address);
      await sellWithMinimalToken(trade, currentPrice, settings, 'stop_loss');
    }
  }
}

/**
 * Build a minimal token-like object from Jupiter price data and execute sell.
 * executeSell expects a `token` object with price_usd, liquidity_usd, market_cap, price_change_5m.
 * We only have price — fill the rest with safe defaults so the sell logic works.
 */
async function sellWithMinimalToken(trade, currentPrice, settings, reason) {
  const token = {
    price_usd:       currentPrice,
    liquidity_usd:   50_000,   // conservative estimate for slippage calc
    market_cap:      0,
    price_change_5m: 0,
  };
  try {
    await executeSell(trade, token, settings, reason, 100);
  } catch (err) {
    log('error', `[FAST_SL] Failed to sell ${trade.token_symbol}: ${err.message}`);
  }
}
