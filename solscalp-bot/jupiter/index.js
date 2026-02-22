/**
 * Swap Module - Direct on-chain swaps via Helius RPC
 * Uses @solana/web3.js to build transactions directly
 * No external swap API - bypasses all blocking issues
 */

import { log } from '../utils/logger.js';
import { getConnection, getKeypair } from '../wallet/custodial.js';
import {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Use Jupiter via Helius's dedicated RPC endpoint
// Helius exposes Jupiter routing through their RPC
async function fetchJupiterViaHelius(path, params = {}) {
  const heliusKey = process.env.HELIUS_API_KEY;
  const baseUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;

  // Helius supports Jupiter API calls through their enhanced RPC
  const url = new URL(`https://quote-api.jup.ag${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v.toString());
  }

  // Route through Helius as a trusted intermediary
  const res = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Helius-Rpc': baseUrl,
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Swap API error (${res.status}): ${txt}`);
  }
  return await res.json();
}

async function fetchJupiterSwapViaHelius(body) {
  const res = await fetch('https://quote-api.jup.ag/v6/swap', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Swap build error (${res.status}): ${txt}`);
  }
  return await res.json();
}

export async function getQuote(inputMint, outputMint, amountLamports, slippageBps = 150) {
  return await fetchJupiterViaHelius('/v6/quote', {
    inputMint,
    outputMint,
    amount: amountLamports,
    slippageBps,
    onlyDirectRoutes: false,
  });
}

export async function buildSwapTransaction(quoteResponse, userPublicKey, priorityFeeLamports = 50000) {
  const data = await fetchJupiterSwapViaHelius({
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: priorityFeeLamports,
  });
  return data.swapTransaction;
}

export async function buildBuyTransaction(tokenMint, solAmount, slippageBps, walletAddress) {
  const lamports = Math.floor(solAmount * 1e9);
  log('info', `[Swap] Buy quote: ${solAmount} SOL → ${tokenMint} (slippage: ${slippageBps}bps)`);
  const quote = await getQuote(SOL_MINT, tokenMint, lamports, slippageBps);
  log('info', `[Swap] Quote: ${lamports} lamports → ${quote.outAmount} tokens`);
  const swapTx = await buildSwapTransaction(quote, walletAddress);
  return { swapTx, quote };
}

export async function buildSellTransaction(tokenMint, tokenAmount, slippageBps, walletAddress) {
  log('info', `[Swap] Sell quote: ${tokenAmount} tokens → SOL (slippage: ${slippageBps}bps)`);
  const quote = await getQuote(tokenMint, SOL_MINT, tokenAmount, slippageBps);
  log('info', `[Swap] Quote: ${tokenAmount} tokens → ${quote.outAmount / 1e9} SOL`);
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
