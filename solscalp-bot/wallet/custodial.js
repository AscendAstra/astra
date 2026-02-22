/**
 * Custodial Wallet
 * Loads keypair from env, signs and sends transactions
 */

import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { loadSettings } from '../config/settings.js';
import { log } from '../utils/logger.js';

let _connection = null;
let _keypair = null;

export function getConnection() {
  if (!_connection) {
    const settings = loadSettings();
    _connection = new Connection(settings.rpc_url, 'confirmed');
  }
  return _connection;
}

export function getKeypair() {
  if (!_keypair) {
    const key = process.env.WALLET_PRIVATE_KEY;
    if (!key) throw new Error('WALLET_PRIVATE_KEY not set');
    try {
      // Support both base58 and JSON array formats
      if (key.startsWith('[')) {
        _keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key)));
      } else {
        _keypair = Keypair.fromSecretKey(bs58.decode(key));
      }
    } catch (e) {
      throw new Error(`Invalid WALLET_PRIVATE_KEY format: ${e.message}`);
    }
  }
  return _keypair;
}

export async function getWalletBalance() {
  const conn = getConnection();
  const kp = getKeypair();
  const lamports = await conn.getBalance(kp.publicKey);
  return lamports / 1e9;
}

export function getWalletAddress() {
  return getKeypair().publicKey.toString();
}

export async function signAndSendTransaction(swapTransaction) {
  const conn = getConnection();
  const kp = getKeypair();
  const settings = loadSettings();

  if (settings.paper_trading) {
    log('info', '[PAPER] Would have sent transaction (paper trading mode)');
    return 'PAPER_TX_' + Date.now();
  }

  // Deserialize the versioned transaction from Jupiter
  const txBuf = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);

  // Sign with custodial wallet
  tx.sign([kp]);

  // Send with retry logic
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const sig = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });

      // Confirm transaction
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
      await conn.confirmTransaction({
        signature: sig,
        blockhash,
        lastValidBlockHeight,
      }, 'confirmed');

      log('info', `Transaction confirmed: ${sig}`);
      return sig;
    } catch (err) {
      log('warn', `Transaction attempt ${attempt} failed: ${err.message}`);
      if (attempt === 3) throw err;
      await sleep(2000 * attempt);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
