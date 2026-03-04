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

// ── CONSECUTIVE STOP LOSS CONSTANTS (shared by momentum + scalp) ────────────
const CONSECUTIVE_STOP_WINDOW_MS = 30 * 60 * 1000; // 30 minute window
const CONSECUTIVE_STOP_THRESHOLD = 2;               // 2 stops triggers pause
const CONSECUTIVE_STOP_PAUSE_MS  = 90 * 60 * 1000; // 90 minute pause

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
  entryHistory:             {},  // { tokenAddress: { count: N, firstEntry: timestamp } }
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

// ── RE-ENTRY COUNTER (shared by momentum + scalp) ──────────────────────────

/**
 * Record an entry for a token (call after successful buy).
 * Optional strategy param stores which strategy made the entry.
 */
export function recordEntry(tokenAddress, strategy = null) {
  const state = load();
  if (!state.entryHistory) state.entryHistory = {};
  const existing = state.entryHistory[tokenAddress];
  if (existing) {
    existing.count++;
    // Append to entries array for strategy-filtered counting
    if (!existing.entries) existing.entries = [];
    existing.entries.push({ at: Date.now(), strategy });
  } else {
    state.entryHistory[tokenAddress] = {
      count: 1,
      firstEntry: Date.now(),
      entries: [{ at: Date.now(), strategy }],
    };
  }
  save(state);
}

/**
 * Get entry count for a token within a time window.
 * When strategy is null (default), counts all entries (backwards compatible).
 * When strategy is provided, only counts entries from that strategy.
 * Prunes entries outside the window automatically.
 */
export function getEntryCount(tokenAddress, windowMs, strategy = null) {
  const state = load();
  if (!state.entryHistory) return 0;
  const entry = state.entryHistory[tokenAddress];
  if (!entry) return 0;

  const now = Date.now();

  // Prune if oldest entry is outside window entirely
  if (now - entry.firstEntry > windowMs) {
    delete state.entryHistory[tokenAddress];
    save(state);
    return 0;
  }

  // Prune individual stale entries from the array to prevent unbounded growth
  if (entry.entries && entry.entries.length > 0) {
    const before = entry.entries.length;
    entry.entries = entry.entries.filter(e => now - e.at <= windowMs);
    entry.count = entry.entries.length;
    if (entry.entries.length < before) {
      save(state); // persist pruned array
    }
  }

  // Strategy-specific counting (for alpha token per-strategy entry caps)
  if (strategy && entry.entries) {
    return entry.entries.filter(e => e.strategy === strategy && now - e.at <= windowMs).length;
  }

  return entry.count;
}

// ── CONSECUTIVE STOP LOSS HELPERS (shared by momentum + scalp) ──────────────

/**
 * Check if the consecutive stop pause is currently active.
 * Returns true if entries should be blocked.
 */
export function isConsecutiveStopPauseActive() {
  const pauseUntil = getConsecutiveStopPauseUntil();
  if (!pauseUntil) return false;

  if (Date.now() < pauseUntil) {
    const minsLeft = Math.ceil((pauseUntil - Date.now()) / 60000);
    log('warn', `[FAILSAFE] ⚠ Consecutive stop loss pause active (${minsLeft}m remaining). Skipping all entries.`);
    return true;
  }

  // Pause expired — clear it from disk
  clearConsecutiveStopPause();
  return false;
}

/**
 * Record a stop loss for the consecutive check window.
 * If threshold is reached, triggers the 90-minute pause.
 */
export function recordStopLossForConsecutiveCheck() {
  const now = Date.now();

  // Load from disk, trim old entries, add new one
  let recentStops = getRecentStopLosses();
  recentStops.push(now);

  const cutoff = now - CONSECUTIVE_STOP_WINDOW_MS;
  recentStops = recentStops.filter(ts => ts >= cutoff);

  // Check if threshold is hit
  if (recentStops.length >= CONSECUTIVE_STOP_THRESHOLD) {
    const pauseUntil = now + CONSECUTIVE_STOP_PAUSE_MS;
    setConsecutiveStopPause(pauseUntil); // saves to disk + clears recentStops
    log('warn', `[FAILSAFE] 🔴 CONSECUTIVE STOP TRIGGERED: ${recentStops.length} stop losses in 30 minutes. Pausing all entries for 90 minutes.`);
  } else {
    saveRecentStopLosses(recentStops); // save updated list
  }
}
