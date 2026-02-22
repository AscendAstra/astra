import { monitorScalpOpportunities } from './strategies/scalp.js';
import { monitorMomentumOpportunities } from './strategies/momentum.js';
import { monitorBreakoutOpportunities } from './strategies/breakout.js';
import { monitorActiveTrades } from './monitor/activeTrades.js';
import { loadSettings } from './config/settings.js';
import { log } from './utils/logger.js';
import { getWalletBalance } from './wallet/custodial.js';
import { startApiServer } from './api/server.js';

let isRunning = false;

async function main() {
  log('info', '=== SolScalp Bot Starting ===');

  await startApiServer();

  const settings = loadSettings();

  if (!settings.is_bot_active) {
    log('warn', 'Bot is disabled. Set IS_BOT_ACTIVE=true to enable.');
    return;
  }

  const balance = await getWalletBalance();
  log('info', `Custodial wallet balance: ${balance} SOL`);

  if (balance < settings.default_trade_amount_sol) {
    log('error', `Insufficient balance (${balance} SOL). Need at least ${settings.default_trade_amount_sol} SOL.`);
    return;
  }

  isRunning = true;
  log('info', 'All systems nominal. Starting strategy loops...');

  runStrategyLoop('SCALP',    monitorScalpOpportunities,    settings.scalp_interval_ms    || 5 * 60 * 1000);
  runStrategyLoop('MOMENTUM', monitorMomentumOpportunities, settings.momentum_interval_ms || 5 * 60 * 1000);
  runStrategyLoop('BREAKOUT', monitorBreakoutOpportunities, settings.breakout_interval_ms || 5 * 60 * 1000);
  runStrategyLoop('MONITOR',  monitorActiveTrades,          settings.monitor_interval_ms  || 60 * 1000);
}

async function runStrategyLoop(name, fn, intervalMs) {
  log('info', `[${name}] Strategy loop started (interval: ${intervalMs / 1000}s)`);
  while (isRunning) {
    try {
      await fn();
    } catch (err) {
      log('erro
