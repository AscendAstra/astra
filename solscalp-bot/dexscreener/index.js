/**
 * DexScreener API - Token scanning and market data
 */

const DEXSCREENER_BASE = 'https://api.dexscreener.com';

/**
 * Fetch top Solana tokens by volume
 * Returns up to 250 pairs sorted by 24h volume
 */
export async function fetchTopSolanaTokens() {
  const url = `${DEXSCREENER_BASE}/latest/dex/search?q=SOL&rankBy=volume&order=desc`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DexScreener error: ${res.status}`);
  const data = await res.json();

  return (data.pairs || [])
    .filter(p =>
      p.chainId === 'solana' &&
      p.baseToken?.address &&
      p.liquidity?.usd > 0 &&
      p.marketCap > 0
    )
    .slice(0, 250)
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
