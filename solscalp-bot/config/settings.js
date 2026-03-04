/**
 * Settings loader — reads from environment variables
 * Set these in Railway's variable panel
 *
 * Regime system overlays FLAT/BULL parameter adjustments on top of
 * base (BEAR) settings. BEAR = current defaults, no changes applied.
 */

import { applyRegime } from './regimes.js';
import { getCurrentRegime } from '../utils/regimeDetector.js';

export function loadSettings() {
  const required = ['HELIUS_API_KEY', 'WALLET_PRIVATE_KEY'];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }

  const baseSettings = {
    // Bot control
    is_bot_active:                  process.env.IS_BOT_ACTIVE !== 'false',
    auto_trade_enabled:             process.env.AUTO_TRADE_ENABLED !== 'false',
    paper_trading:                  process.env.PAPER_TRADING === 'true',

    // RPC
    helius_api_key:                 process.env.HELIUS_API_KEY,
    rpc_url:                        `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,

    // Wallet
    wallet_private_key:             process.env.WALLET_PRIVATE_KEY,

    // General trade settings
    default_trade_amount_sol:       parseFloat(process.env.DEFAULT_TRADE_AMOUNT_SOL  || '0.1'),
    max_trade_size_sol:             parseFloat(process.env.MAX_TRADE_SIZE_SOL        || '0.5'),
    slippage_tolerance:             parseFloat(process.env.SLIPPAGE_TOLERANCE        || '1.5'),
    daily_loss_limit_sol:           parseFloat(process.env.DAILY_LOSS_LIMIT_SOL      || '5'),
    portfolio_limit_percent:        parseFloat(process.env.PORTFOLIO_LIMIT_PERCENT   || '20'),
    min_liquidity_usd:              parseFloat(process.env.MIN_LIQUIDITY_USD         || '5000'),

    // Exit strategy
    target_gain_percent:            parseFloat(process.env.TARGET_GAIN_PERCENT       || '30'),
    stop_loss_percent:              parseFloat(process.env.STOP_LOSS_PERCENT         || '20'),
    partial_exit_enabled:           process.env.PARTIAL_EXIT_ENABLED !== 'false',
    partial_exit_trigger_percent:   parseFloat(process.env.PARTIAL_EXIT_TRIGGER      || '70'),
    partial_exit_sell_percent:      parseFloat(process.env.PARTIAL_EXIT_SELL         || '80'),
    trailing_stop_enabled:          process.env.TRAILING_STOP_ENABLED === 'true',
    trailing_stop_percent:          parseFloat(process.env.TRAILING_STOP_PERCENT     || '10'),

    // Safety
    rug_check_enabled:              process.env.RUG_CHECK_ENABLED !== 'false',
    honeypot_check_enabled:         process.env.HONEYPOT_CHECK_ENABLED !== 'false',
    whale_tracking_enabled:         process.env.WHALE_TRACKING_ENABLED === 'true',
    content_filter_enabled:         process.env.CONTENT_FILTER_ENABLED !== 'false',

    // ── SCALP STRATEGY ──────────────────────────────────────────────────────
    scalp_enabled:                  process.env.SCALP_ENABLED !== 'false',
    scalp_entry_mc_min:             parseFloat(process.env.SCALP_ENTRY_MC_MIN        || '280000'),
    scalp_entry_mc_max:             parseFloat(process.env.SCALP_ENTRY_MC_MAX        || '320000'),
    scalp_exit_mc:                  parseFloat(process.env.SCALP_EXIT_MC             || '500000'),
    scalp_trade_amount_sol:         parseFloat(process.env.SCALP_TRADE_AMOUNT_SOL    || '0.1'),
    scalp_stop_loss_percent:        parseFloat(process.env.SCALP_STOP_LOSS_PERCENT   || '20'),
    scalp_punch_check_enabled:      process.env.SCALP_PUNCH_CHECK_ENABLED !== 'false',
    scalp_volume_multiplier:        parseFloat(process.env.SCALP_VOLUME_MULT         || '3'),
    scalp_volume_multiplier_max:    parseFloat(process.env.SCALP_VOLUME_MULT_MAX     || '15'),
    scalp_target_gain_percent:      parseFloat(process.env.SCALP_TARGET_GAIN         || '30'),
    scalp_max_entries_per_token:    parseInt(process.env.SCALP_MAX_ENTRIES            || '1'),
    scalp_block_hours_start:       parseInt(process.env.SCALP_BLOCK_HOURS_START      || '0'),
    scalp_block_hours_end:         parseInt(process.env.SCALP_BLOCK_HOURS_END        || '6'),
    scalp_interval_ms:              parseInt(process.env.SCALP_INTERVAL_MS           || '90000'),
    scalp_sell_pressure_enabled:    process.env.SCALP_SELL_PRESSURE_ENABLED !== 'false',
    scalp_sell_pressure_threshold:  parseFloat(process.env.SCALP_SELL_PRESSURE_THRESHOLD || '35'),

    // ── MOMENTUM STRATEGY ───────────────────────────────────────────────────
    momentum_enabled:               process.env.MOMENTUM_ENABLED !== 'false',
    momentum_entry_mc_min:          parseFloat(process.env.MOMENTUM_ENTRY_MC_MIN     || '75000'),
    momentum_entry_mc_max:          parseFloat(process.env.MOMENTUM_ENTRY_MC_MAX     || '100000'),
    momentum_exit_mc_min:           parseFloat(process.env.MOMENTUM_EXIT_MC_MIN      || '135000'),
    momentum_exit_mc_max:           parseFloat(process.env.MOMENTUM_EXIT_MC_MAX      || '180000'),
    momentum_volume_multiplier:     parseFloat(process.env.MOMENTUM_VOLUME_MULT      || '9'),   // raised from 5 — data: 9-12x = 58% WR (+0.17 SOL), 5-9x = 33% WR (-0.16 SOL)
    momentum_volume_multiplier_max: parseFloat(process.env.MOMENTUM_VOLUME_MULT_MAX  || '12'),  // new cap — >12x vol = token likely already peaked
    momentum_trade_amount_sol:      parseFloat(process.env.MOMENTUM_TRADE_AMOUNT_SOL || '0.1'),
    momentum_stop_loss_percent:     parseFloat(process.env.MOMENTUM_STOP_LOSS        || '20'),
    momentum_interval_ms:           parseInt(process.env.MOMENTUM_INTERVAL_MS        || '45000'),
    momentum_sell_pressure_enabled:     process.env.MOMENTUM_SELL_PRESSURE_ENABLED !== 'false',
    momentum_sell_pressure_threshold:   parseFloat(process.env.MOMENTUM_SELL_PRESSURE_THRESHOLD || '35'),
    momentum_target_gain_percent:       parseFloat(process.env.MOMENTUM_TARGET_GAIN || '25'),
    momentum_min_5m_pump:               parseFloat(process.env.MOMENTUM_MIN_5M_PUMP || '0'),      // data: negative 5m = 35% WR (-0.11 SOL), positive = 48% WR (+0.18 SOL)
    momentum_max_1h_pump:               parseFloat(process.env.MOMENTUM_MAX_1H_PUMP || '30'),     // data: 1h >30% = 38% WR (-0.21 SOL) — buying tops
    momentum_block_utc_ranges:          process.env.MOMENTUM_BLOCK_UTC_RANGES || '12-15,18-21',

    // ── BREAKOUT STRATEGY ───────────────────────────────────────────────────
    breakout_enabled:               process.env.BREAKOUT_ENABLED !== 'false',
    breakout_entry_mc_min:          parseFloat(process.env.BREAKOUT_ENTRY_MC_MIN     || '2000000'),
    breakout_entry_mc_max:          parseFloat(process.env.BREAKOUT_ENTRY_MC_MAX     || '20000000'),
    breakout_volume_multiplier:     parseFloat(process.env.BREAKOUT_VOLUME_MULT      || '1.5'),
    breakout_min_5m_pump:           parseFloat(process.env.BREAKOUT_MIN_5M_PUMP      || '3'),    // raised from 2 — data: 5m<3% = 26% runner rate, 5m>=3% = 43% runner rate
    breakout_min_buy_pressure:      parseFloat(process.env.BREAKOUT_MIN_BUY_PRESSURE || '55'),
    breakout_trade_amount_sol:      parseFloat(process.env.BREAKOUT_TRADE_AMOUNT_SOL || '0.2'),
    breakout_stop_loss_percent:     parseFloat(process.env.BREAKOUT_STOP_LOSS        || '12'),
    breakout_target_gain_percent:   parseFloat(process.env.BREAKOUT_TARGET_GAIN      || '20'),
    breakout_interval_ms:           parseInt(process.env.BREAKOUT_INTERVAL_MS        || '90000'),
    breakout_allow_repeat_trades:   process.env.BREAKOUT_ALLOW_REPEAT !== 'false',

    // ── BREAKOUT DOWNTREND BOUNCE ─────────────────────────────────────────────
    breakout_dt_enabled:            process.env.BREAKOUT_DT_ENABLED !== 'false',
    breakout_dt_24h_threshold:      parseFloat(process.env.BREAKOUT_DT_24H_THRESHOLD     || '-10'),
    breakout_dt_6h_threshold:       parseFloat(process.env.BREAKOUT_DT_6H_THRESHOLD      || '-3'),
    breakout_dt_14d_threshold:      parseFloat(process.env.BREAKOUT_DT_14D_THRESHOLD     || '20'),
    breakout_dt_min_1h_pump:        parseFloat(process.env.BREAKOUT_DT_MIN_1H_PUMP       || '5'),
    breakout_dt_min_5m_pump:        parseFloat(process.env.BREAKOUT_DT_MIN_5M_PUMP       || '1.5'),
    breakout_dt_min_buy_pressure:   parseFloat(process.env.BREAKOUT_DT_MIN_BUY_PRESSURE  || '62'),
    breakout_dt_volume_multiplier:  parseFloat(process.env.BREAKOUT_DT_VOLUME_MULT       || '3'),
    breakout_dt_min_liquidity:      parseFloat(process.env.BREAKOUT_DT_MIN_LIQUIDITY     || '250000'),
    breakout_dt_stop_loss_percent:  parseFloat(process.env.BREAKOUT_DT_STOP_LOSS         || '8'),
    breakout_min_1h_pump:           parseFloat(process.env.BREAKOUT_MIN_1H_PUMP          || '10'),   // raised from 5 — data: 1h<10% = 0 runners in 27 trades, dead money
    breakout_max_24h_pump:          parseFloat(process.env.BREAKOUT_MAX_24H_PUMP         || '200'),

    // ── BREAKOUT JUPITER DISCOVERY ──────────────────────────────────────────────
    breakout_jupiter_discovery:     process.env.BREAKOUT_JUPITER_DISCOVERY !== 'false',
    breakout_sell_pressure_enabled:     process.env.BREAKOUT_SELL_PRESSURE_ENABLED !== 'false',
    breakout_sell_pressure_threshold:   parseFloat(process.env.BREAKOUT_SELL_PRESSURE_THRESHOLD || '40'),

    // ── MIDCAP GAP FILLER ($320K–$2M) ──────────────────────────────────────────
    midcap_enabled:                 process.env.MIDCAP_ENABLED !== 'false',
    midcap_entry_mc_min:            parseFloat(process.env.MIDCAP_ENTRY_MC_MIN         || '320000'),
    midcap_entry_mc_max:            parseFloat(process.env.MIDCAP_ENTRY_MC_MAX         || '2000000'),
    midcap_trade_amount_sol:        parseFloat(process.env.MIDCAP_TRADE_AMOUNT_SOL     || '0.1'),
    midcap_target_gain_percent:     parseFloat(process.env.MIDCAP_TARGET_GAIN          || '30'),
    midcap_stop_loss_percent:       parseFloat(process.env.MIDCAP_STOP_LOSS            || '15'),
    midcap_volume_multiplier:       parseFloat(process.env.MIDCAP_VOLUME_MULT          || '2'),
    midcap_volume_multiplier_max:   parseFloat(process.env.MIDCAP_VOLUME_MULT_MAX      || '10'),
    midcap_min_1h_pump:             parseFloat(process.env.MIDCAP_MIN_1H_PUMP          || '5'),
    midcap_min_5m_pump:             parseFloat(process.env.MIDCAP_MIN_5M_PUMP          || '3'),    // raised from 1 — data: 5m<3% duds avg +0.4% PnL, 5m>=3% runner rate 35% avg +4.4%
    midcap_min_buy_pressure:        parseFloat(process.env.MIDCAP_MIN_BUY_PRESSURE     || '55'),
    midcap_min_liquidity:           parseFloat(process.env.MIDCAP_MIN_LIQUIDITY        || '25000'),
    midcap_max_24h_pump:            parseFloat(process.env.MIDCAP_MAX_24H_PUMP         || '300'),
    midcap_max_entries_per_token:   parseInt(process.env.MIDCAP_MAX_ENTRIES             || '1'),
    midcap_interval_ms:             parseInt(process.env.MIDCAP_INTERVAL_MS             || '60000'),
    midcap_sell_pressure_enabled:   process.env.MIDCAP_SELL_PRESSURE_ENABLED !== 'false',
    midcap_sell_pressure_threshold: parseFloat(process.env.MIDCAP_SELL_PRESSURE_THRESHOLD || '35'),

    // ── PUMPFUN PRE-MIGRATION STRATEGY ────────────────────────────────────────
    pumpfun_enabled:                process.env.PUMPFUN_ENABLED !== 'false',
    pumpfun_min_mc:                 parseFloat(process.env.PUMPFUN_MIN_MC             || '6000'),
    pumpfun_max_mc:                 parseFloat(process.env.PUMPFUN_MAX_MC             || '25000'),
    pumpfun_max_age_minutes:        parseInt(process.env.PUMPFUN_MAX_AGE_MINUTES      || '10'),
    pumpfun_min_sol_volume:         parseFloat(process.env.PUMPFUN_MIN_SOL_VOLUME     || '40'),
    pumpfun_min_buy_pressure:       parseFloat(process.env.PUMPFUN_MIN_BUY_PRESSURE   || '65'),
    pumpfun_trade_amount_sol:       parseFloat(process.env.PUMPFUN_TRADE_AMOUNT_SOL   || '0.1'),
    pumpfun_target_gain_pct:        parseFloat(process.env.PUMPFUN_TARGET_GAIN        || '25'),
    pumpfun_stop_loss_pct:          parseFloat(process.env.PUMPFUN_STOP_LOSS          || '20'),
    pumpfun_max_concurrent:         parseInt(process.env.PUMPFUN_MAX_CONCURRENT       || '3'),
    pumpfun_stale_timeout_ms:       parseInt(process.env.PUMPFUN_STALE_TIMEOUT_MS     || '600000'),
    pumpfun_alpha_only:                 process.env.PUMPFUN_ALPHA_ONLY === 'true',
    pumpfun_alpha_min_mc:               parseFloat(process.env.PUMPFUN_ALPHA_MIN_MC           || '4000'),
    pumpfun_alpha_min_sol_volume:       parseFloat(process.env.PUMPFUN_ALPHA_MIN_SOL_VOLUME   || '10'),
    pumpfun_alpha_min_buy_pressure:     parseFloat(process.env.PUMPFUN_ALPHA_MIN_BUY_PRESSURE || '55'),
    pumpfun_sell_pressure_enabled:      process.env.PUMPFUN_SELL_PRESSURE_ENABLED !== 'false',
    pumpfun_sell_pressure_threshold:    parseFloat(process.env.PUMPFUN_SELL_PRESSURE_THRESHOLD || '30'),

    // ── ALPHA TRACKING ─────────────────────────────────────────────────────────
    alpha_tracking_enabled:         process.env.ALPHA_TRACKING_ENABLED !== 'false',

    // Stale trade exit
    stale_trade_timeout_ms:         parseInt(process.env.STALE_TRADE_TIMEOUT_MS      || '5400000'), // 90 minutes

    // Monitor
    monitor_interval_ms:            parseInt(process.env.MONITOR_INTERVAL_MS         || '60000'),

    // Fast stop loss (Jupiter Price API)
    fast_sl_interval_ms:            parseInt(process.env.FAST_SL_INTERVAL_MS         || '10000'),
    hard_kill_loss_percent:         parseFloat(process.env.HARD_KILL_LOSS_PERCENT    || '35'),

    // ── QUIET HOURS CHECKPOINT ──────────────────────────────────────────────
    quiet_checkpoint_enabled:       process.env.QUIET_CHECKPOINT_ENABLED !== 'false',
    quiet_checkpoint_delay_ms:      parseInt(process.env.QUIET_CHECKPOINT_DELAY_MS   || '900000'),   // 15 min at zero trades
    quiet_checkpoint_cooldown_ms:   parseInt(process.env.QUIET_CHECKPOINT_COOLDOWN_MS || '14400000'), // 4h between sends
  };

  const regime = getCurrentRegime();
  return applyRegime(baseSettings, regime);
}
