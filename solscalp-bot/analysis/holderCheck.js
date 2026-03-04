/**
 * Holder Concentration Check — Helius DAS API
 *
 * Fetches top token holders for a given mint and determines
 * whether whales are concentrated (top 10 hold >50% of supply).
 *
 * Used on momentum re-entry (2nd attempt) to avoid tokens
 * where whale dumping caused the first stop loss.
 *
 * Cache: 5 minutes per token to avoid hammering Helius.
 * Fallback: API errors return { is_concentrated: false } — don't block trades on API failures.
 */

import { log } from '../utils/logger.js';

// ── IN-MEMORY CACHE ─────────────────────────────────────────────────────────
const cache = new Map(); // tokenAddress → { result, timestamp }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check holder concentration for a token mint.
 * @param {string} tokenAddress - SPL token mint address
 * @returns {{ top10_percent: number, is_concentrated: boolean, holder_count: number }}
 */
export async function checkHolderConcentration(tokenAddress) {
  // Check cache first
  const cached = cache.get(tokenAddress);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result;
  }

  try {
    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey) {
      log('warn', '[HOLDER CHECK] No HELIUS_API_KEY — skipping holder check');
      return { top10_percent: 0, is_concentrated: false, holder_count: 0 };
    }

    const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    const rpc = (method, params) => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).then(d => {
      if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
      return d.result;
    });

    // Two sequential calls (Helius free tier doesn't support batch)
    const [holdersResult, supplyResult] = await Promise.all([
      rpc('getTokenLargestAccounts', [tokenAddress]),
      rpc('getTokenSupply', [tokenAddress]),
    ]);

    const accounts    = holdersResult?.value || [];
    const totalSupply = parseFloat(supplyResult?.value?.uiAmount ?? 0);

    if (accounts.length === 0 || totalSupply === 0) {
      const result = { top10_percent: 0, is_concentrated: false, holder_count: 0 };
      cache.set(tokenAddress, { result, timestamp: Date.now() });
      return result;
    }

    // Top 10 holders as % of total supply (not just top 20)
    const top10 = accounts.slice(0, 10);
    const top10Total = top10.reduce(
      (sum, a) => sum + (a.uiAmount != null ? a.uiAmount : 0),
      0
    );

    const top10Percent = (top10Total / totalSupply) * 100;

    const result = {
      top10_percent: top10Percent,
      is_concentrated: top10Percent > 50,
      holder_count: accounts.length,
    };

    cache.set(tokenAddress, { result, timestamp: Date.now() });

    log('info', `[HOLDER CHECK] ${tokenAddress.slice(0, 8)}... — top 10 hold ${top10Percent.toFixed(1)}% of supply (${accounts.length} largest accounts)`);

    return result;
  } catch (err) {
    log('warn', `[HOLDER CHECK] API error for ${tokenAddress.slice(0, 8)}...: ${err.message} — allowing trade`);
    // Fail open — don't block trades on API errors
    return { top10_percent: 0, is_concentrated: false, holder_count: 0 };
  }
}
