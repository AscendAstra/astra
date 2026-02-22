/**
 * DexScreener API - Token scanning and market data
 */

const DEXSCREENER_BASE = 'https://api.dexscreener.com';

/**
 * Fetch top Solana tokens by volume
 * Uses multiple DexScreener endpoints to build a list of 250 tokens
 */
export async function fetchTopSolanaTokens() {
  const seen = new Map();

  // Strategy: hit multiple DexScreener boosted/top endpoints + searches
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

  // Sort by 24h volume descending, return top 250
  return Array.from(seen.values())
    .sort((a, b) => b.volume_24h - a.volume_24h)
    .slice(0, 250);
}

async function fetchTokenProfiles() {
  // DexScreener's token boosts endpoint — active/trending tokens
  const res = await fetch(`${DEXSCREENER_BASE}/token-boosts/top/v1`);
  if (!res.ok) return [];
  const data = await res.json();

  // Fetch full pair data for each boosted token on Solana
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

  // Return the pair with highest liquidity
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
    address:        p.baseToken.address,
    symbol:         p.baseToken.symbol,
    name:           p.baseToken.name,
    price_usd:      parseFloat(p.priceUsd || 0),
    price_change_5m:  parseFloat(p.priceChange?.m5  || 0),
    price_change_1h:  parseFloat(p.priceChange?.h1  || 0),
    price_change_24h: parseFloat(p.priceChange?.h24 || 0),
    market_cap:     mc,
    liquidity_usd:  liq,
    volume_24h:     vol24h,
    volume_6h:      vol6h,
    volume_1h:      vol1h,
    volume_5m:      vol5m,
    buys_5m:        buys5m,
    sells_5m:       sells5m,
    buy_pressure:   buyPressure,
    pair_address:   p.pairAddress,
    dex_id:         p.dexId,
    created_at:     p.pairCreatedAt,
    url:            p.url,
    // Derived metrics
    volume_mc_ratio: mc > 0 ? vol24h / mc : 0,
    fdv:            p.fdv || mc,
    fdv_liq_ratio:  liq > 0 ? (p.fdv || mc) / liq : 999,
  };
}
