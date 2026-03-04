/**
 * Wallet Reconciliation
 * Runs on startup to detect orphaned tokens (in wallet but no active trade)
 * and phantom trades (active trade but no tokens in wallet).
 */

import { getTokenAccounts } from '../wallet/custodial.js';
import { getActiveTrades, closeTrade } from '../store/trades.js';
import { loadSettings } from '../config/settings.js';
import { log } from './logger.js';
import { notify } from './discord.js';

export async function reconcileWallet() {
  const settings = loadSettings();
  if (settings.paper_trading) {
    log('info', '[RECONCILE] Paper mode — skipping wallet reconciliation.');
    return { orphans: [], phantoms: [] };
  }

  log('info', '[RECONCILE] Starting wallet reconciliation...');

  const tokenAccounts = await getTokenAccounts();
  const activeTrades = getActiveTrades();

  const orphans = [];
  const phantoms = [];

  // Build a set of active trade token addresses for quick lookup
  const activeTradeAddresses = new Set(activeTrades.map(t => t.token_address));

  // Check for orphaned tokens — in wallet but no matching active trade
  for (const account of tokenAccounts) {
    if (account.uiAmount <= 0) continue; // skip zero-balance accounts
    if (!activeTradeAddresses.has(account.mint)) {
      orphans.push({
        mint: account.mint,
        balance: account.uiAmount,
        decimals: account.decimals,
      });
      log('warn', `[RECONCILE] Orphaned token: ${account.mint} — ${account.uiAmount} tokens in wallet, no active trade`);
    }
  }

  // Build a set of wallet token mints for quick lookup
  const walletMints = new Set(tokenAccounts.filter(a => a.uiAmount > 0).map(a => a.mint));

  // Check for phantom trades — active trade but no tokens in wallet
  for (const trade of activeTrades) {
    if (!walletMints.has(trade.token_address)) {
      phantoms.push({
        id: trade.id,
        symbol: trade.token_symbol,
        token_address: trade.token_address,
      });
      log('warn', `[RECONCILE] Phantom trade: ${trade.token_symbol} (${trade.id}) — trade active but 0 tokens in wallet`);

      // Force close phantom trades
      try {
        closeTrade(trade.id, trade.entry_price, 'PHANTOM_RECONCILE', 'phantom_reconcile');
        log('info', `[RECONCILE] Force-closed phantom trade: ${trade.token_symbol}`);
      } catch (err) {
        log('error', `[RECONCILE] Failed to close phantom trade ${trade.id}: ${err.message}`);
      }
    }
  }

  // Send Discord notification if issues found
  if (orphans.length > 0 || phantoms.length > 0) {
    await notify.walletReconciliation(orphans, phantoms);
  }

  log('info', `[RECONCILE] Done — ${orphans.length} orphaned token(s), ${phantoms.length} phantom trade(s)`);
  return { orphans, phantoms };
}
