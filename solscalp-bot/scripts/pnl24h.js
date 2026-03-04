import { readFileSync } from 'fs';
const trades = JSON.parse(readFileSync('data/trades.json', 'utf8'));
const cutoff = new Date('2026-03-02T19:00:00Z');
const recent = trades.filter(t => {
  if (t.status !== 'completed') return false;
  if (t.stale_artifact === true) return false;
  if (new Date(t.exit_time) < cutoff) return false;
  return true;
});

console.log('=== LAST 24H TRADES (excl. stale artifacts) ===');
console.log('Total:', recent.length);

const byStrat = {};
for (const t of recent) {
  const s = t.strategy;
  if (!byStrat[s]) byStrat[s] = { wins: 0, losses: 0, pnl: 0, trades: [] };
  const pnl = t.pnl_sol != null ? t.pnl_sol : (t.amount_sol * (t.pnl_percent / 100));
  byStrat[s].pnl += pnl;
  if (t.pnl_percent >= 0) byStrat[s].wins++;
  else byStrat[s].losses++;
  byStrat[s].trades.push({ sym: t.token_symbol, pct: t.pnl_percent, sol: pnl, reason: t.exit_reason, time: t.exit_time });
}

let totalPnl = 0;
for (const [strat, data] of Object.entries(byStrat)) {
  const total = data.wins + data.losses;
  const wr = total > 0 ? ((data.wins / total) * 100).toFixed(0) : 'N/A';
  console.log('');
  console.log(`${strat.toUpperCase()}: ${data.wins}W/${data.losses}L | WR: ${wr}% | PnL: ${data.pnl.toFixed(4)} SOL`);
  for (const t of data.trades) {
    const sign = t.pct >= 0 ? '+' : '';
    console.log(`  ${t.sym.padEnd(12)} ${sign}${t.pct.toFixed(1)}% | ${t.sol.toFixed(4)} SOL | ${t.reason}`);
  }
  totalPnl += data.pnl;
}

console.log('');
console.log(`=== TOTAL: ${totalPnl.toFixed(4)} SOL ===`);

const active = trades.filter(t => t.status === 'active');
if (active.length > 0) {
  console.log('');
  console.log('=== ACTIVE POSITIONS ===');
  for (const t of active) {
    const pnl = t.pnl_percent ? `${t.pnl_percent.toFixed(1)}%` : 'pending';
    console.log(`  ${t.token_symbol.padEnd(12)} (${t.strategy}) | entry MC: $${(t.entry_market_cap/1000).toFixed(0)}K | P&L: ${pnl}`);
  }
}
