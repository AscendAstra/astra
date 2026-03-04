/**
 * DexScreener API - Token scanning and market data
 * Jupiter Token API V2 - Supplemental discovery via top-traded tokens
 */

import { log } from '../utils/logger.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';

// ── FETCH CACHE (TTL 60s) ──────────────────────────────────────────────────
// Prevents duplicate DexScreener calls when multiple strategies share the same
// fetch function on overlapping intervals (momentum 45s + scalp 90s, etc.)
const FETCH_CACHE_TTL_MS = 60_000;
let topTokensCache    = { ts: 0, data: null };
const midCapCache     = new Map(); // "mcMin:mcMax" → { ts, data }

/**
 * Fetch top Solana tokens by volume (micro-cap focus — used by momentum + scalp)
 * Uses multiple DexScreener search endpoints to build a list of ~250 tokens
 */
export async function fetchTopSolanaTokens() {
  // Return cached result if fresh
  if (topTokensCache.data && Date.now() - topTokensCache.ts < FETCH_CACHE_TTL_MS) {
    return topTokensCache.data;
  }

  const seen = new Map();

  const fetchers = [
    fetchTokenProfiles(),
    fetchBySearch('pump'),
    fetchBySearch('sol'),
    fetchBySearch('meme'),
    fetchBySearch('cat'),
    fetchBySearch('dog'),
    fetchBySearch('pepe'),
    fetchBySearch('moon'),
    fetchBySearch('ai'),
    fetchBySearch('based'),
  ];

  const results = await Promise.allSettled(fetchers);

  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const pair of result.value) {
        if (!seen.has(pair.address)) {
          seen.set(pair.address, pair);
        }
      }
    }
  }

  const result = Array.from(seen.values())
    .sort((a, b) => b.volume_24h - a.volume_24h)
    .slice(0, 250);

  topTokensCache = { ts: Date.now(), data: result };
  return result;
}

/**
 * Fetch top-traded token addresses from Jupiter Token API V2.
 * Returns mint addresses pre-filtered to a coarse MC range (wider than breakout).
 * Fails open: any error → empty array + warning log.
 */
async function fetchJupiterTopTraded() {
  try {
    const headers = {};
    if (process.env.JUPITER_API_KEY) {
      headers['x-api-key'] = process.env.JUPITER_API_KEY;
    }
    const res = await fetch('https://api.jup.ag/tokens/v2/toptraded/1h?limit=100', { headers });
    if (!res.ok) {
      log('warn', `[DEXSCREENER] Jupiter toptraded API returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    const tokens = Array.isArray(data) ? data : (data.tokens || []);

    return tokens
      .filter(t => t.mcap >= 500_000 && t.mcap <= 50_000_000)
      .map(t => t.id || t.address || t.mint)
      .filter(Boolean);
  } catch (err) {
    log('warn', `[DEXSCREENER] Jupiter toptraded fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * Batch-fetch token data from DexScreener by addresses.
 * Chunks into groups of 30 (DexScreener limit), normalizes through filterAndNormalize().
 * Fails open per batch.
 */
async function fetchBatchDexScreenerTokens(addresses) {
  const results = [];
  const chunkSize = 30;

  for (let i = 0; i < addresses.length; i += chunkSize) {
    const chunk = addresses.slice(i, i + chunkSize);
    try {
      const joined = chunk.join(',');
      const res = await fetch(`${DEXSCREENER_BASE}/tokens/v1/solana/${joined}`);
      if (!res.ok) continue;
      const data = await res.json();
      const pairs = Array.isArray(data) ? data : (data.pairs || []);
      results.push(...filterAndNormalize(pairs));
    } catch {}
  }

  return results;
}

/**
 * Fetch mid-cap Solana tokens ($2M–$20M range) — used by breakout strategy.
 *
 * Two discovery sources merged:
 * 1. DexScreener keyword searches (21 terms) — established mid-cap tokens
 * 2. Jupiter toptraded/1h — top tokens by actual swap volume (catches novel names)
 *
 * Jupiter provides only addresses; full data comes from DexScreener batch lookup.
 * Both lists are merged, deduped, and filtered client-side to MC range.
 */
export async function fetchMidCapSolanaTokens(mcMin = 2_000_000, mcMax = 20_000_000, opts = {}) {
  const { jupiterDiscovery = true } = opts;

  // Return cached result if fresh (keyed by MC range — midcap and breakout use different ranges)
  const cacheKey = `${mcMin}:${mcMax}`;
  const cached   = midCapCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < FETCH_CACHE_TTL_MS) {
    return cached.data;
  }

  const seen = new Map();

  // These search terms reliably surface established Solana mid-caps:
  // — Major Solana ecosystem tokens
  // — Established meme coins that have graduated to mid-cap
  // — DeFi/utility tokens in the $2M–$20M range
  const keywordFetchers = [
    // Ecosystem & DeFi tokens
    fetchBySearch('solana'),
    fetchBySearch('raydium'),
    fetchBySearch('jupiter'),
    fetchBySearch('bonk'),
    fetchBySearch('wif'),
    fetchBySearch('jup'),
    fetchBySearch('orca'),
    fetchBySearch('drift'),
    fetchBySearch('tensor'),
    fetchBySearch('popcat'),
    // Established meme coins that live in mid-cap range
    fetchBySearch('fwog'),
    fetchBySearch('mother'),
    fetchBySearch('goat'),
    fetchBySearch('bome'),
    fetchBySearch('myro'),
    fetchBySearch('slerf'),
    fetchBySearch('mew'),
    // Trending broad terms that catch mid-caps
    fetchBySearch('finance'),
    fetchBySearch('protocol'),
    fetchBySearch('network'),
  ];

  // Run keyword searches + Jupiter discovery in parallel
  const parallelWork = [...keywordFetchers];
  if (jupiterDiscovery) {
    parallelWork.push(fetchJupiterTopTraded());
  }

  const results = await Promise.allSettled(parallelWork);

  // Separate keyword results from Jupiter addresses
  const keywordResults = results.slice(0, keywordFetchers.length);
  let jupiterAddresses = [];
  if (jupiterDiscovery && results.length > keywordFetchers.length) {
    const jupResult = results[keywordFetchers.length];
    if (jupResult.status === 'fulfilled') {
      jupiterAddresses = jupResult.value;
    }
  }

  // Merge keyword search results
  for (const result of keywordResults) {
    if (result.status === 'fulfilled') {
      for (const pair of result.value) {
        if (!seen.has(pair.address)) {
          seen.set(pair.address, pair);
        }
      }
    }
  }

  // Jupiter discovery: filter out already-found addresses, batch-lookup the rest
  if (jupiterAddresses.length > 0) {
    const newAddresses = jupiterAddresses.filter(addr => !seen.has(addr));
    if (newAddresses.length > 0) {
      const jupTokens = await fetchBatchDexScreenerTokens(newAddresses);
      let added = 0;
      for (const pair of jupTokens) {
        if (!seen.has(pair.address)) {
          seen.set(pair.address, pair);
          added++;
        }
      }
      log('info', `[DEXSCREENER] Jupiter discovery: +${added} new candidates (${newAddresses.length} looked up)`);
    }
  }

  // Filter to MC range, sort by 1h volume activity (not just 24h)
  // 1h sort is better for breakout — we want tokens moving RIGHT NOW
  const midCaps = Array.from(seen.values())
    .filter(t => t.market_cap >= mcMin && t.market_cap <= mcMax)
    .sort((a, b) => b.volume_1h - a.volume_1h)
    .slice(0, 100);

  midCapCache.set(cacheKey, { ts: Date.now(), data: midCaps });
  return midCaps;
}

async function fetchTokenProfiles() {
  const res = await fetch(`${DEXSCREENER_BASE}/token-boosts/top/v1`);
  if (!res.ok) return [];
  const data = await res.json();

  const solanaTokens = (Array.isArray(data) ? data : [])
    .filter(t => t.chainId === 'solana')
    .slice(0, 30);

  const pairs = [];
  for (const token of solanaTokens) {
    try {
      const tokenPairs = await fetchPairsForToken(token.tokenAddress);
      pairs.push(...tokenPairs);
    } catch {}
  }
  return pairs;
}

async function fetchPairsForToken(address) {
  const res = await fetch(`${DEXSCREENER_BASE}/latest/dex/tokens/${address}`);
  if (!res.ok) return [];
  const data = await res.json();
  return filterAndNormalize(data.pairs || []);
}

async function fetchBySearch(query) {
  const res = await fetch(`${DEXSCREENER_BASE}/latest/dex/search?q=${query}`);
  if (!res.ok) return [];
  const data = await res.json();
  return filterAndNormalize(data.pairs || []);
}

function filterAndNormalize(pairs) {
  return pairs
    .filter(p =>
      p.chainId === 'solana' &&
      p.baseToken?.address &&
      (p.liquidity?.usd || 0) > 1000 &&
      (p.marketCap || p.fdv || 0) > 0 &&
      (p.volume?.h24 || 0) > 500
    )
    .map(normalizePair);
}

/**
 * Fetch a specific token pair by address
 */
export async function fetchTokenData(tokenAddress) {
  const url = `${DEXSCREENER_BASE}/latest/dex/tokens/${tokenAddress}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DexScreener token fetch error: ${res.status}`);
  const data = await res.json();
  if (!data.pairs || data.pairs.length === 0) return null;

  const best = data.pairs
    .filter(p => p.chainId === 'solana')
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

  return best ? normalizePair(best) : null;
}

/**
 * Normalize a DexScreener pair into our internal format
 */
function normalizePair(p) {
  const vol24h  = p.volume?.h24  || 0;
  const vol6h   = p.volume?.h6   || 0;
  const vol1h   = p.volume?.h1   || 0;
  const vol5m   = p.volume?.m5   || 0;
  const mc      = p.marketCap    || p.fdv || 0;
  const liq     = p.liquidity?.usd || 0;

  const buys5m  = p.txns?.m5?.buys  || 0;
  const sells5m = p.txns?.m5?.sells || 0;
  const totalTx = buys5m + sells5m;
  const buyPressure = totalTx > 0 ? (buys5m / totalTx) * 100 : 50;

  return {
    address:          p.baseToken.address,
    symbol:           p.baseToken.symbol,
    name:             p.baseToken.name,
    price_usd:        parseFloat(p.priceUsd || 0),
    price_change_5m:  parseFloat(p.priceChange?.m5  || 0),
    price_change_1h:  parseFloat(p.priceChange?.h1  || 0),
    price_change_6h:  parseFloat(p.priceChange?.h6  || 0),
    price_change_24h: parseFloat(p.priceChange?.h24 || 0),
    market_cap:       mc,
    liquidity_usd:    liq,
    volume_24h:       vol24h,
    volume_6h:        vol6h,
    volume_1h:        vol1h,
    volume_5m:        vol5m,
    buys_5m:          buys5m,
    sells_5m:         sells5m,
    buy_pressure:     buyPressure,
    pair_address:     p.pairAddress,
    dex_id:           p.dexId,
    created_at:       p.pairCreatedAt,
    url:              p.url,
    volume_mc_ratio:  mc > 0 ? vol24h / mc : 0,
    fdv:              p.fdv || mc,
    fdv_liq_ratio:    liq > 0 ? (p.fdv || mc) / liq : 999,
  };
}
