/**
 * ASTRA Watchdog — Process Manager
 * Lightweight parent process that auto-restarts the bot on crash.
 * Intentionally minimal — no bot imports, no dependencies that could fail.
 *
 * Usage: node scripts/watchdog.js
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// Crash loop detection
const CRASH_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const MAX_CRASHES = 5;
const crashTimestamps = [];

function startBot() {
  const child = spawn('node', ['index.js'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: process.env,
  });

  console.log(`[WATCHDOG] Bot started (PID: ${child.pid})`);

  child.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    console.log(`[WATCHDOG] Bot exited (${reason}).`);

    // Track crash timestamps for loop detection
    const now = Date.now();
    crashTimestamps.push(now);

    // Remove timestamps outside the window
    while (crashTimestamps.length > 0 && crashTimestamps[0] < now - CRASH_WINDOW_MS) {
      crashTimestamps.shift();
    }

    // Check for crash loop
    if (crashTimestamps.length >= MAX_CRASHES) {
      console.log(`[WATCHDOG] CRASH LOOP DETECTED — ${MAX_CRASHES} crashes in ${CRASH_WINDOW_MS / 1000}s. Halting.`);
      sendCrashLoopAlert();
      process.exit(1);
    }

    // Normal restart
    console.log(`[WATCHDOG] Restarting in 10s...`);
    sendCrashAlert(reason);
    setTimeout(() => startBot(), 10_000);
  });

  return child;
}

function sendCrashAlert(reason) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: '🚨 ASTRA Bot Crashed — Restarting',
        color: 0xff1744,
        description: `Bot exited: **${reason}**. Auto-restarting in 10s.`,
        footer: { text: 'ASTRA Watchdog' },
        timestamp: new Date().toISOString(),
      }],
    }),
  }).catch(() => {});
}

function sendCrashLoopAlert() {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: '🔥 CRASH LOOP DETECTED — Manual Intervention Required',
        color: 0xd50000,
        description: `Bot crashed **${MAX_CRASHES} times** in ${CRASH_WINDOW_MS / 1000}s. Watchdog has halted. Check logs and restart manually.`,
        footer: { text: 'ASTRA Watchdog' },
        timestamp: new Date().toISOString(),
      }],
    }),
  }).catch(() => {});
}

// Load .env manually (dotenv may not be available in watchdog context)
import('dotenv/config').catch(() => {
  console.log('[WATCHDOG] dotenv not loaded — using existing env vars');
});

startBot();
