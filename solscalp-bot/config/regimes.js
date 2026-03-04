/**
 * Regime Parameter Presets
 *
 * BEAR = current settings (passthrough, no overrides)
 * FLAT = moderate adjustments (higher targets, slightly relaxed entry)
 * BULL = aggressive adjustments (bigger size, wider ranges, faster scans)
 *
 * applyRegime() overlays the regime overrides onto base settings.
 * Pure data file — no side effects, no I/O.
 */

export const REGIMES = {
  BEAR: {},

  FLAT: {
    target_gain_percent:            35,
    breakout_target_gain_percent:   30,
    momentum_exit_mc_min:           150000,
    momentum_exit_mc_max:           200000,
    momentum_volume_multiplier:     4,
    breakout_volume_multiplier:     1.3,
    breakout_min_buy_pressure:      52,
    momentum_entry_mc_min:          70000,
    momentum_entry_mc_max:          120000,
    scalp_entry_mc_min:             270000,
    scalp_entry_mc_max:             340000,
    scalp_volume_multiplier:        2.5,
    scalp_volume_multiplier_max:    18,
    breakout_entry_mc_min:          1500000,
    breakout_entry_mc_max:          25000000,
    midcap_entry_mc_max:            2500000,
    midcap_volume_multiplier:       1.5,
    midcap_min_buy_pressure:        52,
  },

  BULL: {
    momentum_trade_amount_sol:      0.15,
    scalp_trade_amount_sol:         0.15,
    breakout_trade_amount_sol:      0.25,
    momentum_stop_loss_percent:     25,
    scalp_stop_loss_percent:        25,
    breakout_stop_loss_percent:     15,
    target_gain_percent:            45,
    breakout_target_gain_percent:   40,
    momentum_exit_mc_min:           200000,
    momentum_exit_mc_max:           250000,
    momentum_volume_multiplier:     4,
    momentum_volume_multiplier_max: 15,
    breakout_volume_multiplier:     1.2,
    breakout_min_buy_pressure:      50,
    momentum_entry_mc_min:          65000,
    momentum_entry_mc_max:          140000,
    scalp_entry_mc_min:             260000,
    scalp_entry_mc_max:             360000,
    scalp_volume_multiplier:        2,
    scalp_volume_multiplier_max:    20,
    breakout_entry_mc_min:          1500000,
    breakout_entry_mc_max:          30000000,
    momentum_interval_ms:           30000,
    scalp_interval_ms:              60000,
    breakout_interval_ms:           60000,
    daily_loss_limit_sol:           7,
    midcap_target_gain_percent:     45,
    midcap_trade_amount_sol:        0.15,
    midcap_entry_mc_max:            3000000,
    midcap_stop_loss_percent:       18,
    midcap_volume_multiplier:       1.5,
    midcap_min_buy_pressure:        50,
  },
};

/**
 * Overlay regime-specific overrides onto base settings.
 * BEAR returns settings unchanged. FLAT/BULL replace matching keys.
 *
 * @param {object} baseSettings — the raw settings from env vars
 * @param {string} regime — 'BEAR' | 'FLAT' | 'BULL'
 * @returns {object} — settings with regime overrides applied
 */
export function applyRegime(baseSettings, regime) {
  const overrides = REGIMES[regime];
  if (!overrides || Object.keys(overrides).length === 0) return baseSettings;

  return { ...baseSettings, ...overrides };
}
