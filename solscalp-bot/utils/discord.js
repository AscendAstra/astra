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

  await send({
    embeds: [{
      title:       `${emoji} New ${stratName} Entry — ${trade.token_symbol}`,
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

  await send({
    embeds: [{
      title:       `${isWin ? '✅' : '📉'} ${trade.token_symbol} Closed — ${formatPct(pnlPct)}`,
      color:       isWin ? COLOR.GREEN : COLOR.RED,
      description: `Position closed: **${reason.replace(/_/g, ' ').toUpperCase()}**`,
      fields: [
        { name: '📈 P&L %',       value: formatPct(pnlPct),               inline: true },
        { name: '💰 P&L SOL',     value: formatSol(pnlSol),               inline: true },
        { name: '🎯 Strategy',    value: trade.strategy,                   inline: true },
        { name: '📍 Entry MC',    value: formatMC(trade.entry_market_cap), inline: true },
      ],
      footer: { text: 'ASTRA Trading Bot' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function stopLoss(trade, pnlPct, pnlSol) {
  await send({
    embeds: [{
      title:       `🔴 Stop Loss — ${trade.token_symbol} ${formatPct(pnlPct)}`,
      color:       COLOR.RED,
      description: `Stop loss triggered on **${trade.strategy}** position`,
      fields: [
        { name: '📉 Loss %',      value: formatPct(pnlPct),               inline: true },
        { name: '💰 Loss SOL',    value: formatSol(pnlSol),               inline: true },
        { name: '📍 Entry MC',    value: formatMC(trade.entry_market_cap), inline: true },
      ],
      footer: { text: 'ASTRA Trading Bot' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function partialExit(trade, pnlPct, pnlSol) {
  await send({
    embeds: [{
      title:       `⚡ Partial Exit — ${trade.token_symbol} ${formatPct(pnlPct)}`,
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
};
