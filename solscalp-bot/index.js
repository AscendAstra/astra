/**
 * SolScalp Trading Bot - Main Entry Point
 * Runs all three strategies concurrently on Railway
 */
import 'dotenv/config';
import { monitorScalpOpportunities } from './strategies/scalp.js';
import { monitorMomentumOpportunities } from './strategies/momentum.js';
import { monitorBreakoutOpportunities } from './strategies/breakout.js';
import { monitorMidcapOpportunities } from './strategies/midcap.js';
import { startPumpfunStrategy } from './strategies/pumpfun.js';
import { monitorActiveTrades } from './monitor/activeTrades.js';
import { runFastStopLossCheck } from './monitor/fastStopLoss.js';
import { loadSettings } from './config/settings.js';
import { log } from './utils/logger.js';
import { getWalletBalance } from './wallet/custodial.js';
import { startApiServer } from './api/server.js';
import { notify } from './utils/discord.js';
import { diffSettings, saveSettingsSnapshot, formatChanges } from './utils/settingsDiff.js';
import { diffClaudeMd, saveClaudeMdSnapshot } from './utils/claudeMdDiff.js';
import { getRegimeStatus } from './utils/regimeDetector.js';
import { getActiveTrades, getAllTrades } from './store/trades.js';
import { getAlertLevel, getBtcPriceHistory } from './utils/marketGuard.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

console.log('Discord webhook URL:', process.env.DISCORD_WEBHOOK_URL ? 'LOADED ✅' : 'MISSING ❌');

let isRunning = false;

// ── QUIET HOURS CHECKPOINT STATE ──────────────────────────────────────────────
let _quietZeroSince  = null;  // when active trades first hit zero
let _quietLastSentAt = 0;     // last checkpoint send time
const QUIET_STATE_PATH = 'data/quiet_checkpoint.json';

function loadQuietState() {
  try {
    if (existsSync(QUIET_STATE_PATH)) {
      const data = JSON.parse(readFileSync(QUIET_STATE_PATH, 'utf8'));
      _quietLastSentAt = data.lastSentAt || 0;
    }
  } catch { /* corrupt file — start fresh */ }
}

function saveQuietState() {
  try {
    writeFileSync(QUIET_STATE_PATH, JSON.stringify({ lastSentAt: _quietLastSentAt }));
  } catch (err) {
    log('error', `[QUIET] Failed to save state: ${err.message}`);
  }
}

async function checkQuietHours() {
  const settings = loadSettings();
  if (!settings.quiet_checkpoint_enabled) return;

  const active = getActiveTrades();

  // 1. If any open trades, reset timer and return
  if (active.length > 0) {
    if (_quietZeroSince !== null) {
      log('info', '[QUIET] Trade opened — zero-timer reset');
    }
    _quietZeroSince = null;
    return;
  }

  // 2. First time at zero — start counting
  if (_quietZeroSince === null) {
    _quietZeroSince = Date.now();
    return;
  }

  // 3. Still waiting for delay
  const elapsed = Date.now() - _quietZeroSince;
  if (elapsed < settings.quiet_checkpoint_delay_ms) return;

  // 4. Cooldown check — sent too recently?
  if (Date.now() - _quietLastSentAt < settings.quiet_checkpoint_cooldown_ms) return;

  // 5. Fire checkpoint
  log('info', '[QUIET] Quiet period reached — building checkpoint...');

  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  const allTrades = getAllTrades();
  const recent = allTrades.filter(t =>
    (t.status === 'completed' || t.status === 'stopped') &&
    !t.stale_artifact &&
    t.exit_time && new Date(t.exit_time).getTime() > cutoff
  );

  let wins = 0, losses = 0, netSol = 0;
  let bestTrade = null, worstTrade = null;
  const byStrategy = {};

  for (const t of recent) {
    const pnl = t.pnl_sol != null ? t.pnl_sol : (t.amount_sol * (t.pnl_percent || 0) / 100);
    const pct = t.pnl_percent || 0;
    const isWin = pct >= 0;

    if (isWin) wins++; else losses++;
    netSol += pnl;

    if (bestTrade === null || pct > bestTrade) bestTrade = pct;
    if (worstTrade === null || pct < worstTrade) worstTrade = pct;

    const strat = t.strategy || 'unknown';
    if (!byStrategy[strat]) byStrategy[strat] = { wins: 0, losses: 0, net: 0 };
    if (isWin) byStrategy[strat].wins++; else byStrategy[strat].losses++;
    byStrategy[strat].net += pnl;
  }

  // Fetch SOL price from CoinGecko
  let solPrice = null, sol24hChange = null;
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true');
    if (res.ok) {
      const data = await res.json();
      solPrice = data.solana?.usd ?? null;
      sol24hChange = data.solana?.usd_24h_change ?? null;
    }
  } catch (err) {
    log('warn', `[QUIET] CoinGecko fetch failed: ${err.message}`);
  }

  // BTC price from market guard
  const btcHistory = getBtcPriceHistory();
  const btcPrice = btcHistory.length > 0 ? btcHistory.at(-1).price : null;

  // Regime + F&G
  const regimeStatus = getRegimeStatus();
  const fng = regimeStatus.signals?.fngRaw ?? null;
  const regime = regimeStatus.regime;
  const regimeScore = regimeStatus.score;

  // Market guard alert level
  const alertLevel = getAlertLevel();

  const idleMinutes = Math.round(elapsed / 60_000);

  await notify.quietCheckpoint({
    wins, losses, netSol, bestTrade, worstTrade, byStrategy, idleMinutes,
    btcPrice, solPrice, sol24hChange, fng, regime, regimeScore, alertLevel,
  });

  _quietLastSentAt = Date.now();
  saveQuietState();
  _quietZeroSince = null; // reset so next trigger needs another 15min idle
  log('info', `[QUIET] Checkpoint sent — ${wins}W/${losses}L, ${netSol.toFixed(4)} SOL net (24h)`);
}

async function main() {
  log('info', '=== SolScalp Bot Starting ===');

  // Start HTTP API for dashboard
  await startApiServer();

  const settings = loadSettings();

  const regimeStatus = getRegimeStatus();
  log('info', `[REGIME] Current regime: ${regimeStatus.regime} (score: ${regimeStatus.score ?? 'pending'})${regimeStatus.override ? ` [OVERRIDE: ${regimeStatus.override}]` : ''}`);

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

  // Diff CLAUDE.md against last snapshot — post changes to Discord
  const claudeDiff = diffClaudeMd();
  if (claudeDiff) {
    log('info', `[CLAUDE.md] ${claudeDiff.addedCount} lines added, ${claudeDiff.removedCount} lines removed since last run`);
    await notify.claudeUpdate(claudeDiff);
  }
  saveClaudeMdSnapshot();

  isRunning = true;
  loadQuietState();
  log('info', 'All systems nominal. Starting strategy loops...');

  // Run all strategies concurrently
  runStrategyLoop('SCALP',    monitorScalpOpportunities,    settings.scalp_interval_ms    || 5 * 60 * 1000);
  runStrategyLoop('MOMENTUM', monitorMomentumOpportunities, settings.momentum_interval_ms || 5 * 60 * 1000);
  runStrategyLoop('BREAKOUT', monitorBreakoutOpportunities, settings.breakout_interval_ms || 5 * 60 * 1000);
  runStrategyLoop('MIDCAP',   monitorMidcapOpportunities,   settings.midcap_interval_ms   || 60000);
  runStrategyLoop('MONITOR',  monitorActiveTrades,          settings.monitor_interval_ms  || 60 * 1000);
  runStrategyLoop('FAST_SL',  runFastStopLossCheck,         settings.fast_sl_interval_ms  || 10_000);

  runStrategyLoop('QUIET_CHECK', checkQuietHours, 60_000); // check every 60s

  // Pump.fun pre-migration strategy (WebSocket-driven, not polling)
  if (settings.pumpfun_enabled) {
    startPumpfunStrategy(settings);
  }
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
