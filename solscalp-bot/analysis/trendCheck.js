/**
 * CoinGecko 14-day trend check for downtrend bounce detection.
 *
 * checkDowntrend(tokenAddress) → { confirmed: bool, pct_change_14d: number }
 *   - Fetches 14-day price history from CoinGecko free API (no key needed)
 *   - Compares first price vs last price
 *   - 30-min in-memory cache per token address
 *   - Fails open: API errors → { confirmed: false, pct_change_14d: 0 }
 */

import { log } from '../utils/logger.js';

const cache = new Map(); // address → { ts, result }
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours (downtrend status doesn't change fast)

// ── RATE LIMITER ────────────────────────────────────────────────────────────
// Limit fresh CoinGecko calls per breakout cycle to avoid 429 bursts.
// Cached lookups don't count — only new API calls are rate-limited.
const MAX_FRESH_CALLS_PER_CYCLE = 3;
let freshCallCount = 0;
let lastCycleReset = 0;

/**
 * Check if a token is in a confirmed multi-week downtrend.
 * @param {string} tokenAddress — Solana token mint address
 * @param {number} threshold — minimum decline % to confirm (default -20, pass as positive number)
 * @returns {{ confirmed: boolean, pct_change_14d: number }}
 */
export async function checkDowntrend(tokenAddress, threshold = 20) {
  // Check cache
  const cached = cache.get(tokenAddress);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  // Rate limit: max 3 fresh CoinGecko calls per cycle (60-90s window).
  // Reset counter if >30s since last reset (new cycle started).
  const now = Date.now();
  if (now - lastCycleReset > 30_000) {
    freshCallCount = 0;
    lastCycleReset = now;
  }
  if (freshCallCount >= MAX_FRESH_CALLS_PER_CYCLE) {
    log('info', `[TREND] Rate limit: skipping ${tokenAddress.slice(0, 8)}… (${freshCallCount}/${MAX_FRESH_CALLS_PER_CYCLE} calls this cycle)`);
    return { confirmed: false, pct_change_14d: 0 };
  }
  freshCallCount++;

  try {
    const url = `https://api.coingecko.com/api/v3/coins/solana/contract/${tokenAddress}/market_chart?vs_currency=usd&days=14`;
    const res = await fetch(url);

    if (!res.ok) {
      log('warn', `[TREND] CoinGecko ${res.status} for ${tokenAddress.slice(0, 8)}… — assuming not downtrend`);
      return failOpen(tokenAddress);
    }

    const data = await res.json();
    const prices = data.prices; // [[timestamp, price], ...]

    if (!Array.isArray(prices) || prices.length < 2) {
      log('warn', `[TREND] No price data for ${tokenAddress.slice(0, 8)}… — assuming not downtrend`);
      return failOpen(tokenAddress);
    }

    const firstPrice = prices[0][1];
    const lastPrice  = prices[prices.length - 1][1];
    const pctChange  = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;
    const confirmed  = pctChange <= -threshold;

    const result = { confirmed, pct_change_14d: Math.round(pctChange * 10) / 10 };

    log('info', `[TREND] ${tokenAddress.slice(0, 8)}… 14d: ${result.pct_change_14d}% → ${confirmed ? 'DOWNTREND confirmed' : 'not downtrend'}`);

    cache.set(tokenAddress, { ts: Date.now(), result });
    return result;
  } catch (err) {
    log('warn', `[TREND] CoinGecko error: ${err.message} — assuming not downtrend`);
    return failOpen(tokenAddress);
  }
}

function failOpen(tokenAddress) {
  const result = { confirmed: false, pct_change_14d: 0 };
  // Cache failures too (30 min) to avoid hammering CoinGecko on persistent errors
  cache.set(tokenAddress, { ts: Date.now(), result });
  return result;
}
