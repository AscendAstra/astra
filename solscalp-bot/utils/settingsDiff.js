/**
 * ASTRA Settings Differ
 * Compares current settings against last known snapshot.
 * Only diffs keys on the SAFE_KEYS allowlist — credentials never included.
 *
 * Usage:
 *   import { diffSettings, saveSettingsSnapshot } from '../utils/settingsDiff.js';
 *   const changes = diffSettings(currentSettings);
 *   await saveSettingsSnapshot(currentSettings);
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(__dirname, '../data/settings_snapshot.json');

// ── ALLOWLIST — only these keys are ever diffed or stored ─────────────────────
// Credentials (wallet_private_key, helius_api_key, rpc_url) are intentionally absent.
const SAFE_KEYS = [
  // General
  'default_trade_amount_sol',
  'max_trade_size_sol',
  'slippage_tolerance',
  'daily_loss_limit_sol',
  'min_liquidity_usd',

  // Exit
  'target_gain_percent',
  'stop_loss_percent',
  'partial_exit_trigger_percent',
  'partial_exit_sell_percent',
  'trailing_stop_percent',
  'trailing_stop_enabled',

  // Momentum
  'momentum_enabled',
  'momentum_entry_mc_min',
  'momentum_entry_mc_max',
  'momentum_exit_mc_min',
  'momentum_exit_mc_max',
  'momentum_volume_multiplier',
  'momentum_volume_multiplier_max',
  'momentum_trade_amount_sol',
  'momentum_stop_loss_percent',

  // Scalp
  'scalp_enabled',
  'scalp_entry_mc_min',
  'scalp_entry_mc_max',
  'scalp_exit_mc',
  'scalp_trade_amount_sol',
  'scalp_stop_loss_percent',

  // Breakout
  'breakout_enabled',
  'breakout_entry_mc_min',
  'breakout_entry_mc_max',
  'breakout_volume_multiplier',
  'breakout_min_5m_pump',
  'breakout_min_buy_pressure',
  'breakout_trade_amount_sol',
  'breakout_stop_loss_percent',
  'breakout_target_gain_percent',
];

// ── HELPERS ───────────────────────────────────────────────────────────────────

function safeSubset(settings) {
  const out = {};
  for (const key of SAFE_KEYS) {
    if (key in settings) out[key] = settings[key];
  }
  return out;
}

function formatValue(val) {
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') {
    // Show MC values in K for readability
    if (val >= 10000) return `$${(val / 1000).toFixed(0)}K`;
    return String(val);
  }
  return String(val);
}

function friendlyKey(key) {
  return key.replace(/_/g, ' ');
}

// ── MAIN EXPORTS ──────────────────────────────────────────────────────────────

/**
 * Compare current settings against saved snapshot.
 * Returns array of change objects, or empty array if nothing changed.
 */
export function diffSettings(currentSettings) {
  if (!existsSync(SNAPSHOT_PATH)) return []; // first run — nothing to diff

  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch {
    return []; // corrupt snapshot — skip diff
  }

  const current = safeSubset(currentSettings);
  const changes = [];

  for (const key of SAFE_KEYS) {
    const oldVal = snapshot[key];
    const newVal = current[key];

    if (oldVal === undefined && newVal !== undefined) {
      // New key added
      changes.push({ key, oldVal: null, newVal, type: 'added' });
    } else if (oldVal !== undefined && newVal === undefined) {
      // Key removed
      changes.push({ key, oldVal, newVal: null, type: 'removed' });
    } else if (oldVal !== newVal) {
      // Value changed
      changes.push({ key, oldVal, newVal, type: 'changed' });
    }
  }

  return changes;
}

/**
 * Save current safe settings to disk as the new snapshot.
 * Call this after posting the diff to Discord so next restart has a clean baseline.
 */
export function saveSettingsSnapshot(currentSettings) {
  const subset = safeSubset(currentSettings);
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(subset, null, 2));
}

/**
 * Format changes array into human-readable lines for Discord.
 */
export function formatChanges(changes) {
  return changes.map(({ key, oldVal, newVal, type }) => {
    const label = friendlyKey(key);
    if (type === 'added')   return `\`${label}\` → **${formatValue(newVal)}** *(new)*`;
    if (type === 'removed') return `\`${label}\` → *(removed)*`;
    return `\`${label}\` ${formatValue(oldVal)} → **${formatValue(newVal)}**`;
  });
}
