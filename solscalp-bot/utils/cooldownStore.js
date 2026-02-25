/**
 * Cooldown Store — Persistent across bot restarts
 *
 * Saves stop loss cooldowns and consecutive pause state to disk so
 * a bot restart doesn't wipe protection state mid-session.
 *
 * File location: data/cooldowns.json (auto-created if missing)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { log } from './logger.js';

const DATA_DIR  = './data';
const FILE_PATH = './data/cooldowns.json';

// ── ENSURE DATA DIR EXISTS ─────────────────────────────────────────────────────
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// ── DEFAULT STATE ──────────────────────────────────────────────────────────────
const DEFAULT_STATE = {
  stopLossCooldowns:        {},  // { tokenAddress: timestamp }
  consecutiveStopPauseUntil: null, // timestamp or null
  recentStopLosses:         [],  // array of timestamps
};

// ── LOAD FROM DISK ─────────────────────────────────────────────────────────────
function load() {
  try {
    if (!existsSync(FILE_PATH)) return { ...DEFAULT_STATE };
    const raw = readFileSync(FILE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    log('warn', `[COOLDOWN STORE] Failed to read cooldowns.json — using defaults: ${err.message}`);
    return { ...DEFAULT_STATE };
  }
}

// ── SAVE TO DISK ───────────────────────────────────────────────────────────────
function save(state) {
  try {
    writeFileSync(FILE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    log('error', `[COOLDOWN STORE] Failed to save cooldowns.json: ${err.message}`);
  }
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────────

/**
 * Get the timestamp of last stop loss for a token
 * Returns null if no cooldown exists
 */
export function getStopLossCooldown(tokenAddress) {
  const state = load();
  return state.stopLossCooldowns[tokenAddress] ?? null;
}

/**
 * Set stop loss cooldown for a token (call when stop loss fires)
 */
export function setStopLossCooldown(tokenAddress) {
  const state = load();
  state.stopLossCooldowns[tokenAddress] = Date.now();
  save(state);
}

/**
 * Get the consecutive stop pause expiry timestamp
 * Returns null if no pause is active
 */
export function getConsecutiveStopPauseUntil() {
  const state = load();
  return state.consecutiveStopPauseUntil;
}

/**
 * Set the consecutive stop pause (call when threshold is triggered)
 */
export function setConsecutiveStopPause(until) {
  const state = load();
  state.consecutiveStopPauseUntil = until;
  state.recentStopLosses = []; // reset after triggering
  save(state);
  log('warn', `[COOLDOWN STORE] Consecutive stop pause saved to disk until ${new Date(until).toISOString()}`);
}

/**
 * Clear the consecutive stop pause (call when it expires)
 */
export function clearConsecutiveStopPause() {
  const state = load();
  state.consecutiveStopPauseUntil = null;
  save(state);
}

/**
 * Get recent stop loss timestamps for the consecutive check window
 */
export function getRecentStopLosses() {
  const state = load();
  return state.recentStopLosses ?? [];
}

/**
 * Save updated recent stop losses array
 */
export function saveRecentStopLosses(timestamps) {
  const state = load();
  state.recentStopLosses = timestamps;
  save(state);
}

/**
 * Clean up expired cooldowns to keep the file tidy
 * Call this occasionally (e.g. on bot startup)
 */
export function pruneExpiredCooldowns(cooldownMs) {
  const state = load();
  const now   = Date.now();
  let pruned  = 0;

  for (const [addr, ts] of Object.entries(state.stopLossCooldowns)) {
    if (now - ts > cooldownMs) {
      delete state.stopLossCooldowns[addr];
      pruned++;
    }
  }

  if (pruned > 0) {
    save(state);
    log('info', `[COOLDOWN STORE] Pruned ${pruned} expired cooldown(s)`);
  }
}
