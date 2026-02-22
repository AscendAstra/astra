/**
 * Token Quality & PUNCH Score Analysis
 * Evaluates tokens before entering trades
 */

import { log } from '../utils/logger.js';

/**
 * Evaluate basic token quality
 * Returns { score: 0-100, passed: bool, reasons: [] }
 */
export function evaluateTokenQuality(token, settings) {
  let score = 0;
  const reasons = [];
  const flags = [];

  // 1. Liquidity check (min $5K)
  if (token.liquidity_usd < 5000) {
    flags.push('LOW_LIQUIDITY');
    reasons.push(`Liquidity too low: $${token.liquidity_usd.toFixed(0)}`);
  } else if (token.liquidity_usd >= 50000) {
    score += 30;
  } else if (token.liquidity_usd >= 20000) {
    score += 20;
  } else {
    score += 10;
  }

  // 2. Volume momentum (24h volume / MC > 0.5 = high activity)
  const volRatio = token.volume_mc_ratio;
  if (volRatio >= 2.0) {
    score += 35;
    reasons.push(`Excellent volume momentum: ${volRatio.toFixed(2)}x`);
  } else if (volRatio >= 0.5) {
    score += 20;
  } else {
    score += 5;
    flags.push('LOW_VOLUME_MOMENTUM');
  }

  // 3. Buy pressure
  if (token.buy_pressure >= 65) {
    score += 20;
    reasons.push(`Strong buy pressure: ${token.buy_pressure.toFixed(0)}%`);
  } else if (token.buy_pressure >= 50) {
    score += 10;
  } else {
    flags.push('SELL_PRESSURE');
  }

  // 4. Recent 5m price action (not already dumped)
  if (token.price_change_5m < -15) {
    score -= 20;
    flags.push('RAPID_DUMP_5M');
  } else if (token.price_change_5m > 5) {
    score += 15;
  }

  // 5. FDV/Liquidity ratio (lower = healthier)
  if (token.fdv_liq_ratio > 50) {
    flags.push('HIGH_FDV_LIQ_RATIO');
    score -= 10;
  } else if (token.fdv_liq_ratio < 10) {
    score += 10;
  }

  // Normalize to 0-100
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    passed: score >= 50 && flags.length === 0,
    flags,
    reasons,
  };
}

/**
 * PUNCH Score Analysis
 * P = Price momentum
 * U = Underlying liquidity health
 * N = Network/whale activity
 * C = Concentration risk
 * H = Holder distribution
 * Returns { score: 0-100, passed: bool, flags: [] }
 */
export function analyzePunchScore(token) {
  let score = 0;
  const flags = [];

  // P - Price momentum (5m + 1h trend)
  const momentum = (token.price_change_5m * 0.6) + (token.price_change_1h * 0.4);
  if (momentum > 15) score += 25;
  else if (momentum > 5)  score += 15;
  else if (momentum > 0)  score += 8;
  else { score += 0; flags.push('NEGATIVE_MOMENTUM'); }

  // U - Underlying liquidity (FDV/Liq ratio)
  if (token.fdv_liq_ratio < 5)       score += 25;
  else if (token.fdv_liq_ratio < 15) score += 15;
  else if (token.fdv_liq_ratio < 30) score += 8;
  else { flags.push('POOR_LIQUIDITY_DEPTH'); }

  // N - Network activity (tx velocity)
  const txVelocity = token.buys_5m + token.sells_5m;
  if (txVelocity > 100)     score += 20;
  else if (txVelocity > 50) score += 12;
  else if (txVelocity > 20) score += 6;
  else { flags.push('LOW_TX_VELOCITY'); }

  // C - Concentration (approximated by volume consistency)
  const vol6hShare = token.volume_6h > 0 ? token.volume_1h / (token.volume_6h / 6) : 0;
  if (vol6hShare > 0.8 && vol6hShare < 3)   score += 15; // consistent
  else if (vol6hShare > 3)                   { flags.push('VOLUME_SPIKE_SUSPICIOUS'); score += 5; }
  else                                       score += 8;

  // H - Holder health (buy pressure as proxy)
  if (token.buy_pressure >= 60)      score += 15;
  else if (token.buy_pressure >= 50) score += 8;
  else { flags.push('WEAK_HOLDER_SUPPORT'); }

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    passed: score >= 55 && !flags.includes('POOR_LIQUIDITY_DEPTH'),
    flags,
  };
}

/**
 * Integrated health score combining quality + PUNCH
 */
export function computeHealthScore(token, settings, skipPunch = false) {
  const quality = evaluateTokenQuality(token, settings);

  let healthScore = quality.score;
  let allFlags    = [...quality.flags];
  let recommendation = 'AVOID';

  if (!skipPunch) {
    const punch = analyzePunchScore(token);
    // Weighted average: 60% quality, 40% PUNCH
    healthScore = Math.round(quality.score * 0.6 + punch.score * 0.4);
    allFlags    = [...new Set([...quality.flags, ...punch.flags])];

    if (healthScore >= 70 && allFlags.length === 0)      recommendation = 'EXECUTE';
    else if (healthScore >= 55 && allFlags.length <= 1)  recommendation = 'MONITOR';
    else                                                  recommendation = 'AVOID';
  } else {
    // Without PUNCH, use quality score only
    if (quality.score >= 65 && quality.flags.length === 0)     recommendation = 'EXECUTE';
    else if (quality.score >= 50 && quality.flags.length <= 1) recommendation = 'MONITOR';
    else                                                         recommendation = 'AVOID';
  }

  return {
    health_score:   healthScore,
    quality_score:  quality.score,
    recommendation,
    flags:          allFlags,
    should_trade:   recommendation === 'EXECUTE',
  };
}

/**
 * Basic honeypot check — verifies token has recent sells
 * (A token that can't be sold will have 0 sells)
 */
export function basicHoneypotCheck(token) {
  if (token.sells_5m === 0 && token.buys_5m > 10) {
    return { safe: false, flag: 'HONEYPOT_RISK' };
  }
  if (token.fdv_liq_ratio > 100) {
    return { safe: false, flag: 'EXTREME_FDV_LIQ_RATIO' };
  }
  return { safe: true, flag: null };
}
