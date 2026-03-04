/**
 * Regime Detector — Determines market regime (BEAR / FLAT / BULL)
 *
 * Composite score from 3 signals:
 *   1. BTC 2h price trend        (weight: -40 to +40)
 *   2. Fear & Greed index        (weight: -40 to +40)
 *   3. BTC volatility modifier   (weight: -20 to +10)
 *
 * Score < -25 → BEAR | -25 to +25 → FLAT | > +25 → BULL
 * Hysteresis of 5 points prevents rapid flip-flopping at boundaries.
 *
 * Called by marketGuard every 5 minutes (piggybacking on existing BTC checks).
 * Persists state to data/regime.json.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { log } from './logger.js';
import { notify } from './discord.js';

// ── CONSTANTS ────────────────────────────────────────────────────────────────
const REGIME_FILE        = './data/regime.json';
const FNG_API_URL        = 'https://api.alternative.me/fng/';
const FNG_CACHE_TTL_MS   = 15 * 60 * 1000;  // 15 min cache
const BTC_TREND_WINDOW   = 2 * 60 * 60 * 1000;  // 2h window

const BEAR_THRESHOLD     = -25;
const BULL_THRESHOLD     = 25;
const HYSTERESIS         = 5;

// ── STATE ────────────────────────────────────────────────────────────────────
let currentRegime    = 'BEAR';
let lastScore        = null;
let lastSignals      = null;
let fngCache         = { value: null, fetchedAt: 0 };

// ── RESTORE FROM DISK ────────────────────────────────────────────────────────
{
  try {
    if (existsSync(REGIME_FILE)) {
      const saved = JSON.parse(readFileSync(REGIME_FILE, 'utf8'));
      if (['BEAR', 'FLAT', 'BULL'].includes(saved.regime)) {
        currentRegime = saved.regime;
        lastScore     = saved.score ?? null;
        lastSignals   = saved.signals ?? null;
        log('info', `[REGIME] Restored from disk — ${currentRegime} (score: ${lastScore})`);
      }
    }
  } catch (err) {
    log('warn', `[REGIME] Failed to read regime.json — starting fresh: ${err.message}`);
  }
}

// ── PERSISTENCE ──────────────────────────────────────────────────────────────
function saveRegimeState() {
  try {
    writeFileSync(REGIME_FILE, JSON.stringify({
      regime:    currentRegime,
      score:     lastScore,
      signals:   lastSignals,
      updatedAt: Date.now(),
    }, null, 2), 'utf8');
  } catch (err) {
    log('error', `[REGIME] Failed to save regime.json: ${err.message}`);
  }
}

// ── FEAR & GREED FETCH ───────────────────────────────────────────────────────
async function fetchFearAndGreed() {
  const now = Date.now();
  if (fngCache.value !== null && (now - fngCache.fetchedAt) < FNG_CACHE_TTL_MS) {
    return fngCache.value;
  }

  try {
    const res  = await fetch(FNG_API_URL);
    const data = await res.json();
    const value = parseInt(data?.data?.[0]?.value, 10);
    if (!isNaN(value)) {
      fngCache = { value, fetchedAt: now };
      return value;
    }
    log('warn', '[REGIME] F&G response missing value');
    return fngCache.value;  // return stale cache if available
  } catch (err) {
    log('error', `[REGIME] F&G fetch failed: ${err.message}`);
    return fngCache.value;  // return stale cache if available
  }
}

// ── SIGNAL SCORING ───────────────────────────────────────────────────────────

/**
 * BTC 2h trend score: -40 to +40
 * Uses price history from marketGuard (already collected every 5 min).
 *
 * Drop ≥5%  → -40
 * Drop 3-5% → -30
 * Drop 1-3% → -15
 * Flat ±1%  →   0
 * Rise 1-3% → +15
 * Rise 3-5% → +30
 * Rise ≥5%  → +40
 */
function scoreBtcTrend(btcPriceHistory) {
  if (!btcPriceHistory || btcPriceHistory.length < 2) return 0;

  const cutoff        = Date.now() - BTC_TREND_WINDOW;
  const windowEntries = btcPriceHistory.filter(e => e.timestamp >= cutoff);
  if (windowEntries.length < 2) return 0;

  const oldest = windowEntries[0].price;
  const newest = windowEntries[windowEntries.length - 1].price;
  const changePct = ((newest - oldest) / oldest) * 100;

  if (changePct <= -5) return -40;
  if (changePct <= -3) return -30;
  if (changePct <= -1) return -15;
  if (changePct < 1)   return 0;
  if (changePct < 3)   return 15;
  if (changePct < 5)   return 30;
  return 40;
}

/**
 * Fear & Greed score: -40 to +40
 *
 * 0-20  (Extreme Fear) → -40
 * 21-35 (Fear)         → -20
 * 36-50 (Neutral low)  → -5
 * 51-65 (Neutral high) → +5
 * 66-80 (Greed)        → +20
 * 81-100(Extreme Greed) → +40
 */
function scoreFearAndGreed(fngValue) {
  if (fngValue == null) return 0;

  if (fngValue <= 20) return -40;
  if (fngValue <= 35) return -20;
  if (fngValue <= 50) return -5;
  if (fngValue <= 65) return 5;
  if (fngValue <= 80) return 20;
  return 40;
}

/**
 * BTC volatility modifier: -20 to +10
 * High volatility is bearish, low volatility is mildly bullish.
 *
 * Uses currentVol / baselineVolatility ratio from marketGuard.
 *
 * Ratio ≥5x  → -20
 * Ratio 3-5x → -10
 * Ratio 1-3x →   0
 * Ratio <1x  → +10  (calm market)
 */
function scoreVolatility(btcVolatilityHistory, baselineVolatility) {
  if (!baselineVolatility || baselineVolatility <= 0 || !btcVolatilityHistory || btcVolatilityHistory.length === 0) {
    return 0;
  }

  const recent = btcVolatilityHistory.slice(-3);
  const currentVol = recent.reduce((sum, e) => sum + e.changePct, 0) / recent.length;
  const ratio = currentVol / baselineVolatility;

  if (ratio >= 5) return -20;
  if (ratio >= 3) return -10;
  if (ratio >= 1) return 0;
  return 10;
}

// ── REGIME DETERMINATION WITH HYSTERESIS ──────────────────────────────────────
function determineRegime(score, current) {
  // Apply hysteresis — regime change requires crossing threshold + buffer
  if (current === 'BEAR') {
    if (score > BEAR_THRESHOLD + HYSTERESIS) {
      return score > BULL_THRESHOLD ? 'BULL' : 'FLAT';
    }
    return 'BEAR';
  }

  if (current === 'BULL') {
    if (score < BULL_THRESHOLD - HYSTERESIS) {
      return score < BEAR_THRESHOLD ? 'BEAR' : 'FLAT';
    }
    return 'BULL';
  }

  // FLAT — need to cross threshold + hysteresis to leave
  if (score < BEAR_THRESHOLD - HYSTERESIS) return 'BEAR';
  if (score > BULL_THRESHOLD + HYSTERESIS) return 'BULL';
  return 'FLAT';
}

// ── MAIN DETECTION FUNCTION ──────────────────────────────────────────────────
/**
 * Called by marketGuard every 5 minutes with existing data.
 * No additional API calls for BTC data — only fetches F&G (cached 15 min).
 */
export async function runRegimeDetection(btcPriceHistory, btcVolatilityHistory, baselineVolatility) {
  try {
    const fngValue   = await fetchFearAndGreed();
    const trendScore = scoreBtcTrend(btcPriceHistory);
    const fngScore   = scoreFearAndGreed(fngValue);
    const volScore   = scoreVolatility(btcVolatilityHistory, baselineVolatility);
    const composite  = trendScore + fngScore + volScore;

    const signals = {
      btcTrend:   trendScore,
      fearGreed:  fngScore,
      volatility: volScore,
      fngRaw:     fngValue,
    };

    const newRegime = determineRegime(composite, currentRegime);

    log('info', `[REGIME] Score: ${composite} (trend:${trendScore} fng:${fngScore} vol:${volScore}) → ${newRegime}${fngValue != null ? ` | F&G: ${fngValue}` : ''}`);

    if (newRegime !== currentRegime) {
      const prev = currentRegime;
      currentRegime = newRegime;
      lastScore     = composite;
      lastSignals   = signals;
      saveRegimeState();
      log('warn', `[REGIME] ⚡ REGIME CHANGE: ${prev} → ${newRegime} (score: ${composite})`);
      await notify.regimeChange(prev, newRegime, composite, signals);
    } else {
      lastScore   = composite;
      lastSignals = signals;
      saveRegimeState();
    }
  } catch (err) {
    log('error', `[REGIME] Detection failed: ${err.message}`);
  }
}

// ── PUBLIC API ───────────────────────────────────────────────────────────────
export function getCurrentRegime() {
  return process.env.REGIME_OVERRIDE || currentRegime;
}

export function getRegimeStatus() {
  const override = process.env.REGIME_OVERRIDE;
  return {
    regime:   override || currentRegime,
    detected: currentRegime,
    override: override || null,
    score:    lastScore,
    signals:  lastSignals,
  };
}
