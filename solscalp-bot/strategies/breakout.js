/**
 * Strategy 3: Mid-Cap Momentum Scalper
 *
 * Philosophy: Calm, consistent compounding. Find established $2M–$20M MC tokens
 * trending upward, take 15-25% gains, rinse and repeat. These larger tokens are
 * more liquid, less volatile, and stop losses actually hold. Stack 10-30% wins
 * week over week — a month later your money doubles from gentle, consistent trades.
 *
 * Entry criteria:
 *   - MC $2M–$20M (dedicated mid-cap fetch — not the micro-cap list)
 *   - 1h price change +2% (uptrend confirmed on the hour)
 *   - 5m price change +1% (momentum right now, entering into strength)
 *   - Buy pressure 55%+
 *   - Volume 1.5x+ above hourly average
 *   - Liquidity $50K+ (large cap needs real depth)
 *   - Quality score 75+
 *
 * Exit:
 *   - Hard stop loss: -12%
 *   - Primary target: +20%
 *   - Re-entry allowed after 10min cooldown (rinse and repeat)
 */
import { isMarketDangerous, getAlertLevel } from '../utils/marketGuard.js';
import { fetchMidCapSolanaTokens } from '../dexscreener/index.js';
import { evaluateTokenQuality, basicHoneypotCheck } from '../analysis/scoring.js';
import { buildBuyTransaction, calculateSlippage } from '../jupiter/index.js';
import { signAndSendTransaction, getWalletAddress, getWalletBalance } from '../wallet/custodial.js';
import {
  createTrade,
  hasActiveTradeForToken,
  isDailyLossLimitReached,
} from '../store/trades.js';
import { loadSettings } from '../config/settings.js';
import { log } from '../utils/logger.js';
import { notify } from '../utils/discord.js';

const STRATEGY = 'breakout';

// Track recently exited tokens to avoid immediate re-entry (in-memory, resets on restart — acceptable for breakout)
const recentExits = new Map();
const RE_ENTRY_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

export async function monitorBreakoutOpportunities() {
  const settings = loadSettings();
  if (!settings.breakout_enabled) return;

  if (isMarketDangerous()) {
    log('warn', `[BREAKOUT] 🛡 Market guard active (${getAlertLevel()}). Skipping all entries.`);
    return;
  }

  log('info', '[BREAKOUT] Scanning for mid-cap opportunities...');

  if (isDailyLossLimitReached(settings.daily_loss_limit_sol)) {
    log('warn', '[BREAKOUT] Daily loss limit reached. Pausing.');
    return;
  }

  const balance = await getWalletBalance();
  if (balance < settings.breakout_trade_amount_sol) {
    log('warn', `[BREAKOUT] Insufficient balance: ${balance} SOL`);
    return;
  }

  // ── DEDICATED MID-CAP FETCH ─────────────────────────────────────────────────
  // Uses fetchMidCapSolanaTokens() — searches mid-cap specific terms and filters
  // to $2M–$20M MC, sorted by 1h volume. Yields ~20-40 candidates vs ~6 before.
  let candidates;
  try {
    candidates = await fetchMidCapSolanaTokens(
      settings.breakout_entry_mc_min,
      settings.breakout_entry_mc_max
    );
  } catch (err) {
    log('error', `[BREAKOUT] DexScreener fetch failed: ${err.message}`);
    return;
  }

  log('info', `[BREAKOUT] ${candidates.length} mid-cap candidates ($${(settings.breakout_entry_mc_min/1_000_000).toFixed(0)}M–$${(settings.breakout_entry_mc_max/1_000_000).toFixed(0)}M)`);

  // Clean up expired re-entry cooldowns
  const now = Date.now();
  for (const [addr, exitTime] of recentExits.entries()) {
    if (now - exitTime > RE_ENTRY_COOLDOWN_MS) recentExits.delete(addr);
  }

  for (const token of candidates) {
    try {
      await evaluateBreakoutToken(token, settings);
    } catch (err) {
      log('error', `[BREAKOUT] Error evaluating ${token.symbol}: ${err.message}`);
    }
  }
}

// ── CALL THIS FROM activeTrades.js WHEN A BREAKOUT TRADE EXITS ────────────────
export function recordBreakoutExit(tokenAddress) {
  recentExits.set(tokenAddress, Date.now());
}

// ── TOKEN EVALUATION ──────────────────────────────────────────────────────────
async function evaluateBreakoutToken(token, settings) {
  const {
    breakout_volume_multiplier,
    breakout_min_buy_pressure,
  } = settings;

  // 1. Active trade check
  if (hasActiveTradeForToken(token.address, STRATEGY)) return;

  // 2. Re-entry cooldown check
  if (recentExits.has(token.address)) {
    const minsLeft = Math.ceil((RE_ENTRY_COOLDOWN_MS - (Date.now() - recentExits.get(token.address))) / 60000);
    log('info', `[BREAKOUT] ${token.symbol} — re-entry cooldown (${minsLeft}m). Skip.`);
    return;
  }

  // 3. Must be trending UP on the hour — rules out tokens already dumping
  if (!token.price_change_1h || token.price_change_1h < 2) return;

  // 4. Must have positive 5m momentum — enter into strength, not into a stall
  if (!token.price_change_5m || token.price_change_5m < 1) return;

  // 5. Buy pressure check
  if (token.buy_pressure < breakout_min_buy_pressure) return;

  // 6. Volume momentum — 1.5x above hourly average confirms real activity
  const hourlyAvg     = token.volume_24h / 24;
  const volMultiplier = hourlyAvg > 0 ? token.volume_1h / hourlyAvg : 0;
  if (volMultiplier < breakout_volume_multiplier) return;

  // 7. Liquidity check — mid-cap tokens need real depth to fill and exit cleanly
  const minLiquidity = Math.max(settings.min_liquidity_usd, 50_000);
  if (token.liquidity_usd < minLiquidity) return;

  // 8. Honeypot check
  if (settings.honeypot_check_enabled) {
    const hp = basicHoneypotCheck(token);
    if (!hp.safe) {
      log('warn', `[BREAKOUT] ${token.symbol} — ${hp.flag}. Skip.`);
      return;
    }
  }

  // 9. Quality score — strict for mid-cap, we want established tokens only
  const quality = evaluateTokenQuality(token, settings);
  if (quality.score < 75) {
    log('info', `[BREAKOUT] ${token.symbol} — $${(token.market_cap/1_000_000).toFixed(1)}M | Q: ${quality.score} | Below threshold. Skip.`);
    return;
  }

  log('info', `[BREAKOUT] 🎯 Signal: ${token.symbol} — $${(token.market_cap/1_000_000).toFixed(1)}M MC | 1h: +${token.price_change_1h.toFixed(1)}% | 5m: +${token.price_change_5m.toFixed(1)}% | Vol: ${volMultiplier.toFixed(1)}x | Buy: ${token.buy_pressure.toFixed(0)}% | Q: ${quality.score}`);

  await executeBreakoutBuy(token, settings, volMultiplier, quality);
}

// ── EXECUTE BUY ───────────────────────────────────────────────────────────────
async function executeBreakoutBuy(token, settings, volMultiplier, quality) {
  const walletAddress = getWalletAddress();

  const slippageBps = Math.max(
    150,
    calculateSlippage(
      settings.breakout_trade_amount_sol,
      token.liquidity_usd,
      100,
      token.price_change_5m
    )
  );

  log('info', `[BREAKOUT] Entering ${token.symbol} — ${settings.breakout_trade_amount_sol} SOL | slippage: ${slippageBps}bps`);

  try {
    const { swapTx, quote } = await buildBuyTransaction(
      token.address,
      settings.breakout_trade_amount_sol,
      slippageBps,
      walletAddress
    );

    const sig = await signAndSendTransaction(swapTx);

    createTrade({
      strategy:             STRATEGY,
      token_symbol:         token.symbol,
      token_address:        token.address,
      entry_price:          token.price_usd,
      entry_market_cap:     token.market_cap,
      amount_sol:           settings.breakout_trade_amount_sol,
      token_amount:         parseInt(quote.outAmount),
      target_gain_percent:  settings.breakout_target_gain_percent,
      stop_loss_percent:    settings.breakout_stop_loss_percent,
      tx_signature_entry:   sig,
      vol_multiplier:       volMultiplier,
      pump_1h:              token.price_change_1h,
      pump_5m:              token.price_change_5m,
      buy_pressure_entry:   token.buy_pressure,
      quality_score:        quality.score,
      slippage_bps:         slippageBps,
    });

    log('info', `[BREAKOUT] ✅ Entered ${token.symbol} | Tx: ${sig}`);
    await notify.tradeOpen({
      strategy:          STRATEGY,
      token_symbol:      token.symbol,
      entry_market_cap:  token.market_cap,
      amount_sol:        settings.breakout_trade_amount_sol,
      quality_score:     quality.score,
      vol_multiplier:    volMultiplier,
      exit_mc_min:       token.market_cap * (1 + settings.breakout_target_gain_percent / 100),
    });
  } catch (err) {
    log('error', `[BREAKOUT] Buy failed for ${token.symbol}: ${err.message}`);
  }
}
