/**
 * Settings loader — reads from environment variables
 * Set these in Railway's variable panel
 */

export function loadSettings() {
  const required = ['HELIUS_API_KEY', 'WALLET_PRIVATE_KEY'];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }

  return {
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

    // ── SCALP STRATEGY ──────────────────────────────────────────────────────
    scalp_enabled:                  process.env.SCALP_ENABLED !== 'false',
    scalp_entry_mc_min:             parseFloat(process.env.SCALP_ENTRY_MC_MIN        || '280000'),
    scalp_entry_mc_max:             parseFloat(process.env.SCALP_ENTRY_MC_MAX        || '320000'),
    scalp_exit_mc:                  parseFloat(process.env.SCALP_EXIT_MC             || '500000'),
    scalp_trade_amount_sol:         parseFloat(process.env.SCALP_TRADE_AMOUNT_SOL    || '0.1'),
    scalp_stop_loss_percent:        parseFloat(process.env.SCALP_STOP_LOSS_PERCENT   || '20'),
    scalp_punch_check_enabled:      process.env.SCALP_PUNCH_CHECK_ENABLED !== 'false',
    scalp_interval_ms:              parseInt(process.env.SCALP_INTERVAL_MS           || '90000'),

    // ── MOMENTUM STRATEGY ───────────────────────────────────────────────────
    momentum_enabled:               process.env.MOMENTUM_ENABLED !== 'false',
    momentum_entry_mc_min:          parseFloat(process.env.MOMENTUM_ENTRY_MC_MIN     || '75000'),
    momentum_entry_mc_max:          parseFloat(process.env.MOMENTUM_ENTRY_MC_MAX     || '110000'),
    momentum_exit_mc_min:           parseFloat(process.env.MOMENTUM_EXIT_MC_MIN      || '135000'),
    momentum_exit_mc_max:           parseFloat(process.env.MOMENTUM_EXIT_MC_MAX      || '180000'),
    momentum_volume_multiplier:     parseFloat(process.env.MOMENTUM_VOLUME_MULT      || '5'),   // raised from 2 — data shows <5x vol = 0% win rate
    momentum_volume_multiplier_max: parseFloat(process.env.MOMENTUM_VOLUME_MULT_MAX  || '12'),  // new cap — >12x vol = token likely already peaked
    momentum_trade_amount_sol:      parseFloat(process.env.MOMENTUM_TRADE_AMOUNT_SOL || '0.5'),
    momentum_stop_loss_percent:     parseFloat(process.env.MOMENTUM_STOP_LOSS        || '20'),
    momentum_interval_ms:           parseInt(process.env.MOMENTUM_INTERVAL_MS        || '45000'),

    // ── BREAKOUT STRATEGY ───────────────────────────────────────────────────
    breakout_enabled:               process.env.BREAKOUT_ENABLED !== 'false',
    breakout_entry_mc_min:          parseFloat(process.env.BREAKOUT_ENTRY_MC_MIN     || '2000000'),
    breakout_entry_mc_max:          parseFloat(process.env.BREAKOUT_ENTRY_MC_MAX     || '20000000'),
    breakout_volume_multiplier:     parseFloat(process.env.BREAKOUT_VOLUME_MULT      || '1.5'),
    breakout_min_5m_pump:           parseFloat(process.env.BREAKOUT_MIN_5M_PUMP      || '1'),
    breakout_min_buy_pressure:      parseFloat(process.env.BREAKOUT_MIN_BUY_PRESSURE || '55'),
    breakout_trade_amount_sol:      parseFloat(process.env.BREAKOUT_TRADE_AMOUNT_SOL || '0.2'),
    breakout_stop_loss_percent:     parseFloat(process.env.BREAKOUT_STOP_LOSS        || '12'),
    breakout_target_gain_percent:   parseFloat(process.env.BREAKOUT_TARGET_GAIN      || '20'),
    breakout_interval_ms:           parseInt(process.env.BREAKOUT_INTERVAL_MS        || '90000'),
    breakout_allow_repeat_trades:   process.env.BREAKOUT_ALLOW_REPEAT !== 'false',

    // Monitor
    monitor_interval_ms:            parseInt(process.env.MONITOR_INTERVAL_MS         || '60000'),

    // Fast stop loss (Jupiter Price API)
    fast_sl_interval_ms:            parseInt(process.env.FAST_SL_INTERVAL_MS         || '10000'),
  };
}
