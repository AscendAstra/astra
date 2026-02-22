/**
 * Jupiter API v6 - Quote & Swap via Helius
 */

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const SWAP_API  = 'https://quote-api.jup.ag/v6/swap';

import { log } from '../utils/logger.js';

export async function getQuote(inputMint, outputMint, amountLamports, slippageBps = 150) {
  const url = new URL(QUOTE_API);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amountLamports.toString());
  url.searchParams.set('slippageBps', slippageBps.toString());
  url.searchParams.set('onlyDirectRoutes', 'false');

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    // Force IPv4 and longer timeout
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Jupiter quote failed (${res.status}): ${txt}`);
  }
  return await res.json();
}

export async function buildSwapTransaction(quoteResponse, userPublicKey, priorityFeeLamports = 10000) {
  const body = {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true
return Math.min(baseBps, 500);
}
