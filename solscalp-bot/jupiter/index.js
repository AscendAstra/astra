import fetch from 'node-fetch';
import { log } from '../utils/logger.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const QUOTE_API = 'https://api.jup.ag/swap/v1/quote';
const SWAP_API  = 'https://api.jup.ag/swap/v1/swap';
const API_KEY   = () => process.env.JUPITER_API_KEY || '';

export async function getQuote(inputMint, outputMint, amountLamports, slippageBps = 150) {
  const url = new URL(QUOTE_API);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amountLamports.toString());
  url.searchParams.set('slippageBps', slippageBps.toString());
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Accept': 'application/json', 'x-api-key': API_KEY() },
  });
  if (!res.ok) throw new Error(`Jupiter quote failed (${res.status}): ${await res.text()}`);
  return await res.json();
}

export async function buildSwapTransaction(quoteResponse, userPublicKey, priorityFeeLamports = 50000) {
  const res = await fetch(SWAP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-api-key': API_KEY() },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: priorityFeeLamports,
    }),
  });
  if (!res.ok) throw new Error(`Jupiter swap failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.swapTransaction;
}

export async function buildBuyTransaction(tokenMint, solAmount, slippageBps, walletAddress) {
  const lamports = Math.floor(solAmount * 1e9);
  log('info', `[Jupiter] Buy quote: ${solAmount} SOL → ${tokenMint}`);
  const quote = await getQuote(SOL_MINT, tokenMint, lamports, slippageBps);
  log('info', `[Jupiter] Quote: → ${quote.outAmount} tokens`);
  const swapTx = await buildSwapTransaction(quote, walletAddress);
  return { swapTx, quote };
}

export async function buildSellTransaction(tokenMint, tokenAmount, slippageBps, walletAddress) {
  log('info', `[Jupiter] Sell quote: ${tokenAmount} tokens → SOL`);
  const quote = await getQuote(tokenMint, SOL_MINT, tokenAmount, slippageBps);
  log('info', `[Jupiter] Quote: → ${quote.outAmount / 1e9} SOL`);
  const swapTx = await buildSwapTransaction(quote, walletAddress);
  return { swapTx, quote };
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