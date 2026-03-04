/**
 * ASTRA Discord Notifier
 * Sends rich embed messages to a Discord channel via webhook
 * No bot account needed — just a webhook URL from your server
 *
 * Setup:
 *   1. In your Discord server: Edit Channel → Integrations → Webhooks → New Webhook
 *   2. Copy the webhook URL
 *   3. Add to your .env file: DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
 */

import { sanitizeForDisplay } from './contentFilter.js';

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// ── COLORS ────────────────────────────────────────────────────────────────────
const COLOR = {
  GREEN:  0x00c853,
  RED:    0xff1744,
  YELLOW: 0xffd600,
  ORANGE: 0xff6d00,
  BLUE:   0x2979ff,
  PURPLE: 0xaa00ff,
  GREY:   0x607d8b,
  TEAL:   0x00bcd4, // config updates
};

// ── STRATEGY EMOJI ────────────────────────────────────────────────────────────
const STRATEGY_EMOJI = {
  momentum: '🚀',
  scalp:    '⚡',
  breakout: '💎',
};

// ── CORE SEND FUNCTION ────────────────────────────────────────────────────────
async function send(payload) {
  if (!WEBHOOK_URL) return;

  try {
    const res = await fetch(WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error(`[DISCORD] Webhook failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error(`[DISCORD] Send error: ${err.message}`);
  }
}

// ── FORMAT HELPERS ────────────────────────────────────────────────────────────
function formatMC(mc) {
  if (mc >= 1_000_000) return `$${(mc / 1_000_000).toFixed(2)}M`;
  if (mc >= 1_000)     return `$${(mc / 1_000).toFixed(0)}K`;
  return `$${mc}`;
}

function formatSol(sol) {
  const sign = sol >= 0 ? '+' : '';
  return `${sign}${sol.toFixed(4)} SOL`;
}

function formatPct(pct) {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

// ── NOTIFICATION TYPES ────────────────────────────────────────────────────────

async function tradeOpen(trade) {
  const emoji = STRATEGY_EMOJI[trade.strategy] || '📈';
  const stratName = trade.strategy.charAt(0).toUpperCase() + trade.strategy.slice(1);
  const symbol = sanitizeForDisplay(trade.token_symbol);

  await send({
    embeds: [{
      title:       `${emoji} New ${stratName} Entry — ${symbol}`,
      color:       COLOR.GREEN,
      description: `ASTRA entered a new position`,
      fields: [
        { name: '📍 Entry MC',    value: formatMC(trade.entry_market_cap),              inline: true },
        { name: '💰 Size',        value: `${trade.amount_sol} SOL`,                     inline: true },
        { name: '🎯 Strategy',    value: stratName,                                     inline: true },
        { name: '⭐ Quality',     value: `${trade.quality_score || 'N/A'}`,             inline: true },
        { name: '📊 Vol',         value: `${trade.vol_multiplier?.toFixed(1) || 'N/A'}x`, inline: true },
        { name: '🏁 Target',      value: formatMC(trade.exit_mc_min || 0),              inline: true },
      ],
      footer: { text: 'ASTRA Trading Bot' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function tradeClose(trade, pnlPct, pnlSol, reason) {
  const isWin = pnlPct >= 0;
  const symbol = sanitizeForDisplay(trade.token_symbol);

  const fields = [
    { name: '📈 P&L %',       value: formatPct(pnlPct),               inline: true },
    { name: '💰 Est. P&L',    value: formatSol(pnlSol),               inline: true },
    { name: '💵 Actual P&L',  value: trade.actual_pnl_sol != null ? formatSol(trade.actual_pnl_sol) : 'N/A', inline: true },
    { name: '🎯 Strategy',    value: trade.strategy,                   inline: true },
    { name: '📍 Entry MC',    value: formatMC(trade.entry_market_cap), inline: true },
  ];

  await send({
    embeds: [{
      title:       `${isWin ? '✅' : '📉'} ${symbol} Closed — ${formatPct(pnlPct)}`,
      color:       isWin ? COLOR.GREEN : COLOR.RED,
      description: `Position closed: **${reason.replace(/_/g, ' ').toUpperCase()}**`,
      fields,
      footer: { text: 'ASTRA Trading Bot' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function stopLoss(trade, pnlPct, pnlSol) {
  const symbol = sanitizeForDisplay(trade.token_symbol);
  const fields = [
    { name: '📉 Loss %',      value: formatPct(pnlPct),               inline: true },
    { name: '💰 Est. Loss',   value: formatSol(pnlSol),               inline: true },
    { name: '💵 Actual P&L',  value: trade.actual_pnl_sol != null ? formatSol(trade.actual_pnl_sol) : 'N/A', inline: true },
    { name: '📍 Entry MC',    value: formatMC(trade.entry_market_cap), inline: true },
  ];
  await send({
    embeds: [{
      title:       `🔴 Stop Loss — ${symbol} ${formatPct(pnlPct)}`,
      color:       COLOR.RED,
      description: `Stop loss triggered on **${trade.strategy}** position`,
      fields,
      footer: { text: 'ASTRA Trading Bot' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function partialExit(trade, pnlPct, pnlSol) {
  const symbol = sanitizeForDisplay(trade.token_symbol);
  await send({
    embeds: [{
      title:       `⚡ Partial Exit — ${symbol} ${formatPct(pnlPct)}`,
      color:       COLOR.GREEN,
      description: `Scalp partial exit executed (80%). Remaining 20% still running.`,
      fields: [
        { name: '📈 P&L %',       value: formatPct(pnlPct),  inline: true },
        { name: '💰 Realized',    value: formatSol(pnlSol),  inline: true },
        { name: '🎯 Remaining',   value: '20% still open',   inline: true },
      ],
      footer: { text: 'ASTRA Trading Bot' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function marketAlert(level, reason, btcPrice) {
  const configs = {
    YELLOW: { emoji: '🟡', color: COLOR.YELLOW, action: 'All new entries paused' },
    ORANGE: { emoji: '🟠', color: COLOR.ORANGE, action: 'Entries paused + momentum stops tightened' },
    RED:    { emoji: '🔴', color: COLOR.RED,    action: 'Entries paused + momentum positions closing NOW' },
  };

  const cfg = configs[level] || configs.YELLOW;

  await send({
    embeds: [{
      title:       `${cfg.emoji} MARKET ALERT — ${level}`,
      color:       cfg.color,
      description: `**${reason}**`,
      fields: [
        { name: '🤖 Bot Action',  value: cfg.action,                                inline: false },
        { name: '₿ BTC Price',   value: `$${btcPrice?.toLocaleString() || 'N/A'}`, inline: true },
      ],
      footer: { text: 'ASTRA Market Guard' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function allClear(btcPrice) {
  await send({
    embeds: [{
      title:       `✅ ALL CLEAR — Market Stable`,
      color:       COLOR.GREY,
      description: `BTC has been stable for 4+ hours. Normal trading resuming.`,
      fields: [
        { name: '₿ BTC Price',   value: `$${btcPrice?.toLocaleString() || 'N/A'}`, inline: true },
      ],
      footer: { text: 'ASTRA Market Guard' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function dailySummary(wins, losses, netSol, topWin, worstLoss) {
  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(0) : 0;
  const isProfit = netSol >= 0;

  await send({
    embeds: [{
      title:       `📊 ASTRA Daily Summary`,
      color:       isProfit ? COLOR.GREEN : COLOR.RED,
      description: `Here's how ASTRA performed today`,
      fields: [
        { name: '✅ Wins',        value: `${wins}`,                                   inline: true },
        { name: '❌ Losses',      value: `${losses}`,                                 inline: true },
        { name: '🎯 Win Rate',    value: `${winRate}%`,                               inline: true },
        { name: '💰 Net P&L',    value: formatSol(netSol),                           inline: true },
        { name: '🏆 Best Trade', value: topWin    ? formatPct(topWin)    : 'N/A',    inline: true },
        { name: '📉 Worst Trade',value: worstLoss ? formatPct(worstLoss) : 'N/A',    inline: true },
      ],
      footer: { text: 'ASTRA Trading Bot — Paper Trading Mode' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function botStarted(balance, changes = []) {
  const hasChanges = changes.length > 0;

  const fields = [
    { name: '💼 Balance',     value: `${balance.toFixed(4)} SOL`, inline: true },
    { name: '📋 Mode',        value: 'Paper Trading',              inline: true },
    { name: '🛡 Protection',  value: 'Market Guard Active',        inline: true },
  ];

  if (hasChanges) {
    fields.push({
      name:   '⚙️ Config Changes',
      value:  changes.join('\n'),
      inline: false,
    });
  }

  await send({
    embeds: [{
      title:       `🤖 ASTRA Bot Started`,
      color:       hasChanges ? COLOR.TEAL : COLOR.BLUE,
      description: hasChanges
        ? `All systems nominal. **${changes.length} setting${changes.length > 1 ? 's' : ''} updated** since last run.`
        : `All systems nominal. Strategies running.`,
      fields,
      footer: { text: 'ASTRA Trading Bot' },
      timestamp: new Date().toISOString(),
    }],
  });
}

/**
 * Standalone config update notification — call any time you want to announce changes
 * without a full restart. changes = array of formatted strings from formatChanges().
 */
async function configUpdate(changes, note = '') {
  if (!changes.length) return;

  await send({
    embeds: [{
      title:       `⚙️ Config Updated — ASTRA`,
      color:       COLOR.TEAL,
      description: note || `${changes.length} setting${changes.length > 1 ? 's' : ''} changed`,
      fields: [
        {
          name:   'Changes',
          value:  changes.join('\n'),
          inline: false,
        },
      ],
      footer: { text: 'ASTRA Trading Bot' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function claudeUpdate(diff) {
  let body = diff.recap || 'Content changed (no recap section found)';

  // Truncate to Discord embed limit
  if (body.length > 3800) {
    body = body.substring(0, 3800) + '\n\n*... truncated*';
  }

  await send({
    embeds: [{
      title:       `📝 CLAUDE.md Updated`,
      color:       COLOR.PURPLE,
      description: body,
      fields: [
        { name: '➕ Added',   value: `${diff.addedCount} lines`,   inline: true },
        { name: '➖ Removed', value: `${diff.removedCount} lines`, inline: true },
      ],
      footer: { text: 'ASTRA Trading Bot' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function regimeChange(prev, next, score, signals) {
  const REGIME_EMOJI = { BEAR: '\u{1F43B}', FLAT: '\u2796', BULL: '\u{1F402}' };
  const REGIME_COLOR = { BEAR: COLOR.RED, FLAT: COLOR.GREY, BULL: COLOR.GREEN };

  const emoji = REGIME_EMOJI[next] || '\u2753';
  const color = REGIME_COLOR[next] || COLOR.GREY;

  const signalBreakdown = signals
    ? `BTC Trend: ${signals.btcTrend > 0 ? '+' : ''}${signals.btcTrend} | F&G: ${signals.fearGreed > 0 ? '+' : ''}${signals.fearGreed}${signals.fngRaw != null ? ` (raw: ${signals.fngRaw})` : ''} | Vol: ${signals.volatility > 0 ? '+' : ''}${signals.volatility}`
    : 'N/A';

  await send({
    embeds: [{
      title:       `${emoji} Regime Change — ${prev} → ${next}`,
      color:       color,
      description: `Market regime shifted to **${next}**. Trading parameters adjusted automatically.`,
      fields: [
        { name: '\u{1F4CA} Composite Score', value: `${score}`,          inline: true },
        { name: '\u{1F527} Signals',         value: signalBreakdown,     inline: false },
      ],
      footer: { text: 'ASTRA Regime Detector' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function alphaStageEntry(token, source, stage, mc) {
  const symbol = sanitizeForDisplay(token.symbol || token.token_symbol || '???');
  const stageLabel = stage.toUpperCase();
  const mcStr = formatMC(mc);
  const stageNum = { pumpfun: 1, midcap: 2, breakout: 3 }[stage] || '?';

  await send({
    embeds: [{
      title:       `\u{1F3F7} Alpha Token Stage Entry`,
      color:       COLOR.PURPLE,
      description: `**${symbol}** (${source}) entered **${stageLabel}** at ${mcStr} MC`,
      fields: [
        { name: '\u{1F4CD} Strategy', value: stageLabel,         inline: true },
        { name: '\u{1F4CA} MC',       value: mcStr,              inline: true },
        { name: '\u{1F50D} Source',   value: source,             inline: true },
        { name: '\u{1F9E9} Stage',    value: `${stageNum} of 3`, inline: true },
      ],
      footer: { text: 'ASTRA Alpha Tracker' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function quietCheckpoint({ wins, losses, netSol, bestTrade, worstTrade, byStrategy, idleMinutes, btcPrice, solPrice, sol24hChange, fng, regime, regimeScore, alertLevel }) {
  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(0) : '0';
  const color = totalTrades === 0 ? COLOR.GREY : (netSol >= 0 ? COLOR.GREEN : COLOR.RED);

  const fields = [
    { name: '✅ Wins',        value: `${wins}`,                                    inline: true },
    { name: '❌ Losses',      value: `${losses}`,                                  inline: true },
    { name: '🎯 Win Rate',    value: `${winRate}%`,                                inline: true },
    { name: '💰 Net PnL',     value: formatSol(netSol),                            inline: true },
    { name: '🏆 Best Trade',  value: bestTrade  != null ? formatPct(bestTrade)  : 'N/A',   inline: true },
    { name: '📉 Worst Trade', value: worstTrade != null ? formatPct(worstTrade) : 'N/A',   inline: true },
  ];

  // Strategy breakdown (conditional — only if trades exist)
  if (byStrategy && Object.keys(byStrategy).length > 0) {
    const lines = Object.entries(byStrategy).map(([strat, s]) => {
      const wr = (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(0) : '0';
      const emoji = STRATEGY_EMOJI[strat] || '📈';
      return `${emoji} **${strat.toUpperCase()}:** ${s.wins}W/${s.losses}L (${wr}%) | ${formatSol(s.net)}`;
    });
    fields.push({ name: '📋 Strategy Breakdown', value: lines.join('\n'), inline: false });
  }

  // F&G emoji mapping
  const fngEmoji = fng == null ? '❓' : fng <= 25 ? '😰' : fng <= 45 ? '😐' : fng <= 55 ? '🙂' : fng <= 75 ? '😏' : '🤩';

  fields.push(
    { name: '₿ BTC',          value: btcPrice != null ? `$${btcPrice.toLocaleString()}` : 'N/A',           inline: true },
    { name: '◎ SOL',          value: solPrice != null ? `$${solPrice.toFixed(2)}` : 'N/A',                 inline: true },
    { name: '◎ SOL 24h',      value: sol24hChange != null ? `${sol24hChange >= 0 ? '+' : ''}${sol24hChange.toFixed(2)}%` : 'N/A', inline: true },
    { name: `${fngEmoji} Fear & Greed`, value: fng != null ? `${fng}` : 'N/A',                             inline: true },
    { name: '📊 Regime',      value: regime ? `${regime} (${regimeScore ?? '?'})` : 'N/A',                 inline: true },
    { name: '🛡 Market Guard', value: alertLevel || 'NONE',                                                inline: true },
  );

  await send({
    embeds: [{
      title:       `☕ Quiet Hours — Your Solana Briefing`,
      color,
      description: `All positions closed. ASTRA idle for ${idleMinutes} minutes. Here's your briefing.`,
      fields,
      footer: { text: 'ASTRA Trading Bot — Paper Trading Mode' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function walletReconciliation(orphans, phantoms) {
  const lines = [];
  for (const o of orphans) {
    lines.push(`**Orphan:** \`${o.mint.slice(0, 8)}...\` — ${o.balance} tokens (no trade)`);
  }
  for (const p of phantoms) {
    lines.push(`**Phantom:** ${p.symbol} (\`${p.id}\`) — trade active, 0 tokens → force closed`);
  }

  await send({
    embeds: [{
      title:       `🔍 Wallet Reconciliation`,
      color:       COLOR.ORANGE,
      description: lines.join('\n') || 'No issues found.',
      fields: [
        { name: 'Orphaned Tokens', value: `${orphans.length}`, inline: true },
        { name: 'Phantom Trades',  value: `${phantoms.length}`, inline: true },
      ],
      footer: { text: 'ASTRA Reconciliation' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function killSwitch(count) {
  await send({
    embeds: [{
      title:       `🚨 KILL SWITCH ACTIVATED`,
      color:       COLOR.RED,
      description: `Emergency shutdown triggered. All trading halted.`,
      fields: [
        { name: '📊 Trades Closed', value: `${count}`, inline: true },
      ],
      footer: { text: 'ASTRA Kill Switch' },
      timestamp: new Date().toISOString(),
    }],
  });
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────
export const notify = {
  tradeOpen,
  tradeClose,
  stopLoss,
  partialExit,
  marketAlert,
  allClear,
  dailySummary,
  botStarted,
  configUpdate,
  claudeUpdate,
  regimeChange,
  alphaStageEntry,
  quietCheckpoint,
  walletReconciliation,
  killSwitch,
};
