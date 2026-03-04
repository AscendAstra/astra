import { readFileSync, writeFileSync } from 'fs';
const trades = JSON.parse(readFileSync('data/trades.json', 'utf8'));
const cutoff = new Date('2026-03-02T19:00:00Z');

let tagged = 0;
for (const t of trades) {
  if (t.stale_artifact === true) continue;
  if (t.status !== 'completed') continue;
  if (new Date(t.exit_time) < cutoff) continue;

  // Tag pumpfun trades with absurd PnL (entry price unit mismatch)
  if (t.strategy === 'pumpfun' && Math.abs(t.pnl_percent) > 200) {
    t.stale_artifact = true;
    t.stale_reason = 'Entry price unit mismatch — WebSocket solAmount/tokenAmount vs DexScreener USD exit.';
    tagged++;
    console.log('Tagged artifact:', t.token_symbol, `${t.pnl_percent.toFixed(1)}%`);
  } else if (t.strategy === 'pumpfun') {
    console.log('REAL pumpfun:', t.token_symbol, `${t.pnl_percent.toFixed(1)}%`, t.exit_reason);
  }
}

writeFileSync('data/trades.json', JSON.stringify(trades, null, 2));
console.log(`\nTagged ${tagged} more artifacts`);
