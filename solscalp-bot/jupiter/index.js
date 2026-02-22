/**
 * Jupiter API v6 - Quote & Swap
 * All calls are browser/client-side HTTP - no serverless needed
 */

import { log } from '../utils/logger.js';

const QUOTE_API   = 'https://quote-api.jup.ag/v6/quote';
const SWAP_API    = 'https://quote-api.jup.ag/v6/swap';
const SOL_MINT    = 'So11111111111111111111111111111111111111112';
const WSOL_MINT   = 'So11111111111111111111111111111111111111112';

/**
 * Get a quote from Jupiter
 * @param {string} inputMint
 * @param {string} outputMint
 * @param {number} amountLamports
 * @param {number} slippageBps
 */
export async function getQuote(inputMint, outputMint, amountLamports, slippageBps = 150) {
  const url = new URL(QUOTE_API);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amountLamports.toString());
  url.searchParams.set('slippageBps', slippageBps.toString());
  url.searchParams.set('onlyDirectRoutes', 'false');

 const res = await fetch(url.toString(), {
  headers: {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0',
  }
});
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Jupiter quote failed (${res.status}): ${txt}`);
  }
  return await res.json();
}

/**
 * Build a swap transaction from a quote
 * @param {object} quoteResponse - from getQuote()
 * @param {string} userPublicKey - wallet address
 * @param {number} priorityFeeLamports
 */
export async function buildSwapTransaction(quoteResponse, userPublicKey, priorityFeeLamports = 10000) {
  const body = {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: priorityFeeLamports,
  };

  const res = await fetch(SWAP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Jupiter swap build failed (${res.status}): ${txt}`);
  }

  const data = await res.json();
  return data.swapTransaction; // base64 encoded versioned transaction
}

/**
 * Buy a token with SOL
 * @param {string} tokenMint
 * @param {number} solAmount
 * @param {number} slippageBps
 * @param {string} walletAddress
 */
export async function buildBuyTransaction(tokenMint, solAmount, slippageBps, walletAddress) {
  const lamports = Math.floor(solAmount * 1e9);
  log('info', `[Jupiter] Getting buy quote: ${solAmount} SOL → ${tokenMint} (slippage: ${slippageBps}bps)`);

  const quote = await getQuote(SOL_MINT, tokenMint, lamports, slippageBps);
  log('info', `[Jupiter] Quote: ${lamports} lamports → ${quote.outAmount} tokens`);

  const swapTx = await buildSwapTransaction(quote, walletAddress);
  return { swapTx, quote };
}

/**
 * Sell a token back to SOL
 * @param {string} tokenMint
 * @param {number} tokenAmount - raw token amount (with decimals)
 * @param {number} slippageBps
 * @param {string} walletAddress
 */
export async function buildSellTransaction(tokenMint, tokenAmount, slippageBps, walletAddress) {
  log('info', `[Jupiter] Getting sell quote: ${tokenAmount} tokens → SOL (slippage: ${slippageBps}bps)`);

  const quote = await getQuote(tokenMint, SOL_MINT, tokenAmount, slippageBps);
  log('info', `[Jupiter] Quote: ${tokenAmount} tokens → ${quote.outAmount / 1e9} SOL`);

  const swapTx = await buildSwapTransaction(quote, walletAddress);
  return { swapTx, quote };
}

/**
 * Calculate dynamic slippage based on trade size vs liquidity
 */
export function calculateSlippage(solAmount, liquidityUsd, solPrice = 150, volatility5m = 0) {
  const tradeUsd = solAmount * solPrice;
  const tradeImpact = tradeUsd / liquidityUsd;

  let baseBps = 100; // 1% base

  // Scale with trade impact on liquidity
  if (tradeImpact > 0.05) baseBps += 200;
  else if (tradeImpact > 0.02) baseBps += 100;
  else if (tradeImpact > 0.01) baseBps += 50;

  // Add volatility buffer
  if (Math.abs(volatility5m) > 20) baseBps += 150;
  else if (Math.abs(volatility5m) > 10) baseBps += 75;

  return Math.min(baseBps, 500); // Cap at 5%
}
