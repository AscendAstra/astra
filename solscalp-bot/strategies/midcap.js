/**
 * Strategy: Midcap Gap Filler
 *
 * Philosophy: Take the 30% and walk away. No greed, no hope trades.
 * Fills the $320K–$2M MC blind spot between scalp ($320K max) and breakout ($2M min).
 *
 * Entry criteria:
 *   - MC $320K–$2M (the exact gap)
 *   - 1h price change +5% (must be actively trending)
 *   - 5m price change +1% (enter into strength, not a stall)
 *   - 24h pump cap 300% (block extreme rug risk)
 *   - Buy pressure 55%+
 *   - Volume 2x–10x above hourly average
 *   - Liquidity $25K+ (graduated pumpfun tokens may start lower)
 *   - Quality score 55+
 *
 * Exit:
 *   - Target: +30%
 *   - Stop loss: -15% (tighter — this range has better liquidity, stops hold)
 *   - Hard kill: -35% (shared circuit breaker)
 *   - Sell pressure: exit if buy_pressure < 35% while in profit
 *   - Stale: 90min timeout (shared)
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
import {
  getEntryCount,
  recordEntry,
  getStopLossCooldown,
  setStopLossCooldown,
  isConsecutiveStopPauseActive,
  recordStopLossForConsecutiveCheck,
} from '../utils/cooldownStore.js';
import { loadSettings } from '../config/settings.js';
import { log } from '../utils/logger.js';
import { notify } from '../utils/discord.js';
import { isTokenBlocked } from '../utils/contentFilter.js';
import {
  isAlphaToken,
  getAlphaToken,
  recordAlphaStage,
  loadAlphaSources,
} from '../store/alphaTokens.js';

const STRATEGY = 'midcap';

export async function monitorMidcapOpportunities() {
  const settings = loadSettings();
  if (!settings.midcap_enabled) return;

  if (isMarketDangerous()) {
    log('warn', `[MIDCAP] 🛡 Market guard active (${getAlertLevel()}). Skipping all entries.`);
    return;
  }

  log('info', '[MIDCAP] Scanning for midcap opportunities...');

  if (isDailyLossLimitReached(settings.daily_loss_limit_sol)) {
    log('warn', '[MIDCAP] Daily loss limit reached. Pausing.');
    return;
  }

  const balance = await getWalletBalance();
  if (balance < settings.midcap_trade_amount_sol) {
    log('warn', `[MIDCAP] Insufficient balance: ${balance} SOL`);
    return;
  }

  // ── FETCH — reuses existing dual-source infrastructure ─────────────────────
  let candidates;
  try {
    candidates = await fetchMidCapSolanaTokens(
      settings.midcap_entry_mc_min,
      settings.midcap_entry_mc_max
    );
  } catch (err) {
    log('error', `[MIDCAP] Fetch failed: ${err.message}`);
    return;
  }

  log('info', `[MIDCAP] ${candidates.length} candidates ($${(settings.midcap_entry_mc_min/1000).toFixed(0)}K–$${(settings.midcap_entry_mc_max/1_000_000).toFixed(1)}M)`);

  for (const token of candidates) {
    try {
      await evaluateMidcapToken(token, settings);
    } catch (err) {
      log('error', `[MIDCAP] Error evaluating ${token.symbol}: ${err.message}`);
    }
  }
}

// ── STOP LOSS RECORDING — called from activeTrades.js and fastStopLoss.js ────
export function recordMidcapStopLoss(tokenAddress) {
  setStopLossCooldown(tokenAddress);
  recordStopLossForConsecutiveCheck();
}

// ── TOKEN EVALUATION ────────────────────────────────────────────────────────
async function evaluateMidcapToken(token, settings) {
  // 1. Content filter — block offensive tokens
  if (isTokenBlocked(token.symbol, token.name, settings)) return;

  // 2. Active trade check
  if (hasActiveTradeForToken(token.address, STRATEGY)) return;

  // 3. Per-token cooldown (45min via cooldownStore)
  const lastStopLoss = getStopLossCooldown(token.address);
  if (lastStopLoss) {
    const cooldownMs = 45 * 60 * 1000;
    const elapsed = Date.now() - lastStopLoss;
    if (elapsed < cooldownMs) return;
  }

  // 3b. Consecutive stop pause (shared — 2 stops in 30min → 90min pause)
  if (isConsecutiveStopPauseActive()) {
    log('info', `[MIDCAP] Consecutive stop pause active. Skipping all entries.`);
    return;
  }

  // 4. Re-entry cap (1/token/24h) — alpha tokens use strategy-specific count
  const alphaAware = settings.alpha_tracking_enabled && isAlphaToken(token.address);
  const entryCount = alphaAware
    ? getEntryCount(token.address, 24 * 60 * 60 * 1000, STRATEGY)
    : getEntryCount(token.address, 24 * 60 * 60 * 1000);
  if (entryCount >= settings.midcap_max_entries_per_token) {
    log('info', `[MIDCAP] ${token.symbol} — max entries reached (${entryCount}/${settings.midcap_max_entries_per_token} in 24h). Skip.`);
    return;
  }

  // 5. 1h pump minimum (+5%)
  if (!token.price_change_1h || token.price_change_1h < settings.midcap_min_1h_pump) return;

  // 6. 5m pump minimum (+1%)
  if (!token.price_change_5m || token.price_change_5m < settings.midcap_min_5m_pump) return;

  // 7. 24h pump cap (300% max — block extreme rug risk)
  if (token.price_change_24h > settings.midcap_max_24h_pump) {
    log('info', `[MIDCAP] ${token.symbol} — 24h pump +${token.price_change_24h.toFixed(0)}% exceeds cap (${settings.midcap_max_24h_pump}%). Skip.`);
    return;
  }

  // 8. Buy pressure (55%+)
  if (token.buy_pressure < settings.midcap_min_buy_pressure) return;

  // 9. Volume multiplier (2x–10x)
  const hourlyAvg = token.volume_24h / 24;
  const volMultiplier = hourlyAvg > 0 ? token.volume_1h / hourlyAvg : 0;
  if (volMultiplier < settings.midcap_volume_multiplier || volMultiplier > settings.midcap_volume_multiplier_max) return;

  // 10. Liquidity ($25K+)
  if (token.liquidity_usd < settings.midcap_min_liquidity) return;

  // 11. Honeypot check
  if (settings.honeypot_check_enabled) {
    const hp = basicHoneypotCheck(token);
    if (!hp.safe) {
      log('warn', `[MIDCAP] ${token.symbol} — ${hp.flag}. Skip.`);
      return;
    }
  }

  // 12. Quality score (55+)
  const quality = evaluateTokenQuality(token, settings);
  if (quality.score < 55) {
    log('info', `[MIDCAP] ${token.symbol} — $${(token.market_cap/1000).toFixed(0)}K | Q: ${quality.score} | Below threshold. Skip.`);
    return;
  }

  // ── SIGNAL ────────────────────────────────────────────────────────────────
  log('info', `[MIDCAP] 🎯 Signal: ${token.symbol} — $${(token.market_cap/1000).toFixed(0)}K MC | 1h: +${token.price_change_1h.toFixed(1)}% | 5m: +${token.price_change_5m.toFixed(1)}% | Vol: ${volMultiplier.toFixed(1)}x | Buy: ${token.buy_pressure.toFixed(0)}% | Q: ${quality.score}`);

  // 13. Execute buy
  await executeMidcapBuy(token, settings, volMultiplier, quality);
}

// ── EXECUTE BUY ─────────────────────────────────────────────────────────────
async function executeMidcapBuy(token, settings, volMultiplier, quality) {
  const walletAddress = getWalletAddress();

  const slippageBps = Math.max(
    150,
    calculateSlippage(
      settings.midcap_trade_amount_sol,
      token.liquidity_usd,
      100,
      token.price_change_5m
    )
  );

  log('info', `[MIDCAP] Entering ${token.symbol} — ${settings.midcap_trade_amount_sol} SOL | slippage: ${slippageBps}bps`);

  try {
    const { swapTx, quote } = await buildBuyTransaction(
      token.address,
      settings.midcap_trade_amount_sol,
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
      amount_sol:           settings.midcap_trade_amount_sol,
      token_amount:         parseInt(quote.outAmount),
      target_gain_percent:  settings.midcap_target_gain_percent,
      stop_loss_percent:    settings.midcap_stop_loss_percent,
      tx_signature_entry:   sig,
      vol_multiplier:       volMultiplier,
      pump_1h:              token.price_change_1h,
      pump_5m:              token.price_change_5m,
      buy_pressure_entry:   token.buy_pressure,
      quality_score:        quality.score,
      slippage_bps:         slippageBps,
      price_change_24h:     token.price_change_24h,
    });

    recordEntry(token.address, STRATEGY);

    // Alpha stage tracking
    if (settings.alpha_tracking_enabled && isAlphaToken(token.address)) {
      recordAlphaStage(token.address, STRATEGY, token.market_cap);
      const alpha = getAlphaToken(token.address);
      const sources = loadAlphaSources();
      const sourceLabel = sources.find(s => s.id === alpha.source)?.label || alpha.source;
      log('info', `[MIDCAP] \u{1F3F7} Alpha token entering: ${token.symbol} (${sourceLabel}) — stage 2`);
      notify.alphaStageEntry({ symbol: token.symbol }, sourceLabel, STRATEGY, token.market_cap).catch(() => {});
    }

    log('info', `[MIDCAP] ✅ Entered ${token.symbol} | Tx: ${sig}`);
    await notify.tradeOpen({
      strategy:          STRATEGY,
      token_symbol:      token.symbol,
      entry_market_cap:  token.market_cap,
      amount_sol:        settings.midcap_trade_amount_sol,
      quality_score:     quality.score,
      vol_multiplier:    volMultiplier,
      exit_mc_min:       token.market_cap * (1 + settings.midcap_target_gain_percent / 100),
    });
  } catch (err) {
    log('error', `[MIDCAP] Buy failed for ${token.symbol}: ${err.message}`);
  }
}
