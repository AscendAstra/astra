/**
 * SolScalp Trading Bot - Main Entry Point
 * Runs all three strategies concurrently on Railway
 */
import 'dotenv/config';
import { monitorScalpOpportunities } from './strategies/scalp.js';
import { monitorMomentumOpportunities } from './strategies/momentum.js';
import { monitorBreakoutOpportunities } from './strategies/breakout.js';
import { monitorActiveTrades } from './monitor/activeTrades.js';
import { runFastStopLossCheck } from './monitor/fastStopLoss.js';
import { loadSettings } from './config/settings.js';
import { log } from './utils/logger.js';
import { getWalletBalance } from './wallet/custodial.js';
import { startApiServer } from './api/server.js';
import { notify } from './utils/discord.js';
import { diffSettings, saveSettingsSnapshot, formatChanges } from './utils/settingsDiff.js';

console.log('Discord webhook URL:', process.env.DISCORD_WEBHOOK_URL ? 'LOADED ✅' : 'MISSING ❌');

let isRunning = false;

async function main() {
  log('info', '=== SolScalp Bot Starting ===');

  // Start HTTP API for dashboard
  await startApiServer();

  const settings = loadSettings();

  if (!settings.is_bot_active) {
    log('warn', 'Bot is disabled in settings. Set IS_BOT_ACTIVE=true to enable.');
    process.exit(0);
  }

  const balance = await getWalletBalance();
  log('info', `Custodial wallet balance: ${balance} SOL`);

  // Diff settings against last snapshot — credentials are never included
  const rawChanges       = diffSettings(settings);
  const formattedChanges = formatChanges(rawChanges);

  if (rawChanges.length > 0) {
    log('info', `[CONFIG] ${rawChanges.length} setting(s) changed since last run:`);
    for (const c of rawChanges) {
      log('info', `  ${c.key}: ${c.oldVal} → ${c.newVal}`);
    }
  }

  // Fire Discord — includes change summary if anything changed
  await notify.botStarted(balance, formattedChanges);

  // Save snapshot AFTER posting so next restart can diff against this run
  saveSettingsSnapshot(settings);

  isRunning = true;
  log('info', 'All systems nominal. Starting strategy loops...');

  // Run all strategies concurrently
  runStrategyLoop('SCALP',    monitorScalpOpportunities,    settings.scalp_interval_ms    || 5 * 60 * 1000);
  runStrategyLoop('MOMENTUM', monitorMomentumOpportunities, settings.momentum_interval_ms || 5 * 60 * 1000);
  runStrategyLoop('BREAKOUT', monitorBreakoutOpportunities, settings.breakout_interval_ms || 5 * 60 * 1000);
  runStrategyLoop('MONITOR',  monitorActiveTrades,          settings.monitor_interval_ms  || 60 * 1000);
  runStrategyLoop('FAST_SL',  runFastStopLossCheck,         settings.fast_sl_interval_ms  || 10_000);
}

async function runStrategyLoop(name, fn, intervalMs) {
  log('info', `[${name}] Strategy loop started (interval: ${intervalMs / 1000}s)`);
  while (isRunning) {
    try {
      await fn();
    } catch (err) {
      log('error', `[${name}] Unhandled error: ${err.message}`);
    }
    await sleep(intervalMs);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

process.on('SIGTERM', () => {
  log('warn', 'SIGTERM received. Shutting down gracefully...');
  isRunning = false;
  setTimeout(() => process.exit(0), 5000);
});

process.on('SIGINT', () => {
  log('warn', 'SIGINT received. Shutting down...');
  isRunning = false;
  setTimeout(() => process.exit(0), 2000);
});

main().catch(err => {
  log('error', `Fatal error: ${err.message}`);
  process.exit(1);
});
