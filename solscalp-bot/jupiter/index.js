/**
 * Swap Module - Uses Raydium API via Helius RPC
 * No external API calls that get blocked - pure on-chain via Helius
 */

import { log } from '../utils/logger.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const RAYDIUM_QUOTE_API = 'https://transaction-v1.raydium.io/compute/swap-base-in';
const RAYDIUM_SWAP_API  = 'https://transaction-v1.raydium.io/swap';

export async function getQuote(inputMint, outputMint, amountLamports, slippageBps = 150) {
  const url = new URL(RAYDIUM_QUOTE_API);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amountLamports.toString());
  url.searchParams.set('slippageBps', slippageBps.toString());
  url.searchParams.set('txVersion', 'V0');

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Raydium quote failed (${res.status}): ${txt}`);
  }

  const data = await res.json();
  if (!data.success) throw new Error(`Raydium quote error: ${JSON.stringify(data)}`);
  return data.data;
}

export async function buildSwapTransaction(quoteData, userPublicKey, priorityFeeLamports = 10000) {
  const res = await fetch(RAYDIUM_SWAP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      computeUnitPriceMicroLamports: String(priorityFeeLamports),
      swapResponse: quoteData,
      txVersion: 'V0',
      wallet: userPublicKey,
      wrapSol: true,
      unwrapSol: true,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Raydium swap build failed (${res.status}): ${txt}`);
  }

  const data = await res.json();
  if (!data.success) throw new Error(`Raydium swap error: ${JSON.stringify(data)}`);
  return data.data?.[0]?.transaction;
}

export async function buildBuyTransaction(tokenMint, solAmount, slippageBps, walletAddress) {
  const lamports = Math.floor(solAmount * 1e9);
  log('info', `[Raydium] Getting buy quote: ${solAmount} SOL → ${tokenMint} (slippage: ${slippageBps}bps)`);
  const quote = await getQuote(SOL_MINT, tokenMint, lamports, slippageBps);
  log('info', `[Raydium] Quote received → ${quote.outputAmount} tokens`);
  const swapTx = await buildSwapTransaction(quote, walletAddress);
  return { swapTx, quote: { ...quote, outAmount: quote.outputAmount } };
}

export async function buildSellTransaction(tokenMint, tokenAmount, slippageBps, walletAddress) {
  log('info', `[Raydium] Getting sell quote: ${tokenAmount} tokens → SOL (slippage: ${slippageBps}bps)`);
  const quote = await getQuote(tokenMint, SOL_MINT, tokenAmount, slippageBps);
  log('info', `[Raydium] Quote received → ${quote.outputAmount / 1e9} SOL`);
  const swapTx = await buildSwapTransaction(quote, walletAddress);
  return { swapTx, quote: { ...quote, outAmount: quote.outputAmount } };
}

export function calculateSlippage(solAmount, liquidityUsd, solPrice = 150, volatility5m = 0) {
  const tradeUsd = solAmount * solPrice;
  const tradeImpact = tradeUsd / liquidityUsd;
  let baseBps = 100;
  if (tradeImpact > 0.05) baseBps += 200;
  else if (tradeImpact > 0.02) baseBps += 100;
  else if (tradeImpact > 0.01) baseBps += 50;
  if (Math.abs(volatility5m) > 20) baseBps += 150;
  else if (Math.abs(volatility5m) > 10) baseBps += 75;
  return Math.min(baseBps, 500);
}
