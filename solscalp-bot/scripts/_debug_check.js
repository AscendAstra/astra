import fs from 'fs';
const trades = JSON.parse(fs.readFileSync('data/trades.json', 'utf8'));

// 1. Check downtrend bounce count
const b = trades.filter(t => t.strategy === 'breakout' && (t.status === 'completed' || t.status === 'stopped') && !t.stale_artifact);
const dt = b.filter(t => t.downtrend_bounce === true);
const normal = b.filter(t => !t.downtrend_bounce);
const dtW = dt.filter(t => (t.pnl_percent || 0) >= 0).length;
const dtN = dt.reduce((s, t) => s + (t.pnl_sol ?? (t.amount_sol * ((t.pnl_percent || 0) / 100))), 0);
console.log('=== BREAKOUT: Downtrend Bounce Path ===');
console.log('DT bounces:', dt.length, '|', dtW + 'W/' + (dt.length - dtW) + 'L | net:', dtN.toFixed(4), 'SOL');
console.log('Normal entries:', normal.length);

// 2. Simulate: how many of the 101 breakout trades would pass NEW filters (5m>=3, 1h>=10)?
const wouldPass = b.filter(t => (t.pump_5m || 0) >= 3 && (t.pump_1h || 0) >= 10);
const wouldFail = b.filter(t => (t.pump_5m || 0) < 3 || (t.pump_1h || 0) < 10);
const passW = wouldPass.filter(t => (t.pnl_percent || 0) >= 0).length;
const passNet = wouldPass.reduce((s, t) => s + (t.pnl_sol ?? (t.amount_sol * ((t.pnl_percent || 0) / 100))), 0);
const failW = wouldFail.filter(t => (t.pnl_percent || 0) >= 0).length;
const failNet = wouldFail.reduce((s, t) => s + (t.pnl_sol ?? (t.amount_sol * ((t.pnl_percent || 0) / 100))), 0);
console.log('\n=== BREAKOUT: New Filter Simulation (5m>=3% AND 1h>=10%) ===');
console.log('Would PASS:', wouldPass.length, '|', passW + 'W/' + (wouldPass.length - passW) + 'L | net:', passNet.toFixed(4), 'SOL');
console.log('Would FAIL:', wouldFail.length, '|', failW + 'W/' + (wouldFail.length - failW) + 'L | net:', failNet.toFixed(4), 'SOL');

// 3. Check DT trades against new normal filters — would any DT bounce pass normal filters?
const dtWouldPassNormal = dt.filter(t => (t.pump_5m || 0) >= 3 && (t.pump_1h || 0) >= 10);
console.log('DT bounces that would also pass normal filters:', dtWouldPassNormal.length, '/', dt.length);

// 4. Simulate midcap: how many of 55 trades pass 5m>=3%?
const mc = trades.filter(t => t.strategy === 'midcap' && (t.status === 'completed' || t.status === 'stopped') && !t.stale_artifact);
const mcPass = mc.filter(t => (t.pump_5m || 0) >= 3);
const mcFail = mc.filter(t => (t.pump_5m || 0) < 3);
const mcPassW = mcPass.filter(t => (t.pnl_percent || 0) >= 0).length;
const mcPassNet = mcPass.reduce((s, t) => s + (t.pnl_sol ?? (t.amount_sol * ((t.pnl_percent || 0) / 100))), 0);
const mcFailW = mcFail.filter(t => (t.pnl_percent || 0) >= 0).length;
const mcFailNet = mcFail.reduce((s, t) => s + (t.pnl_sol ?? (t.amount_sol * ((t.pnl_percent || 0) / 100))), 0);
console.log('\n=== MIDCAP: New Filter Simulation (5m>=3%) ===');
console.log('Would PASS:', mcPass.length, '|', mcPassW + 'W/' + (mcPass.length - mcPassW) + 'L | net:', mcPassNet.toFixed(4), 'SOL');
console.log('Would FAIL:', mcFail.length, '|', mcFailW + 'W/' + (mcFail.length - mcFailW) + 'L | net:', mcFailNet.toFixed(4), 'SOL');

// 5. Check the midcap 1h pump filter — current min is 5%, NOT being changed. Verify it's used correctly.
const mcLow1h = mc.filter(t => (t.pump_1h || 0) < 5);
console.log('\nMidcap trades with 1h < 5% (should be 0 — filtered at entry):', mcLow1h.length);

// 6. Verify breakout code uses the settings — check that breakout_max_24h_pump is checked
const bHigh24h = b.filter(t => (t.price_change_24h || 0) > 200);
console.log('\n=== BREAKOUT: Trades with 24h > 200% (current cap) ===');
console.log('Count:', bHigh24h.length, '(should be 0 if filter works)');
for (const t of bHigh24h) {
  console.log('  ', t.token_symbol, '| 24h:', (t.price_change_24h || 0).toFixed(0) + '%', '| pnl:', (t.pnl_percent || 0).toFixed(1) + '%');
}

// 7. Check regimes — do the breakout DT settings get overridden by regime?
console.log('\n=== REGIME CHECK ===');
try {
  const { loadSettings } = await import('../config/settings.js');
  const s = loadSettings();
  console.log('breakout_min_5m_pump:', s.breakout_min_5m_pump, '(expected 3)');
  console.log('breakout_min_1h_pump:', s.breakout_min_1h_pump, '(expected 10)');
  console.log('breakout_dt_min_5m_pump:', s.breakout_dt_min_5m_pump, '(DT path, expected 1.5)');
  console.log('breakout_dt_min_1h_pump:', s.breakout_dt_min_1h_pump, '(DT path, expected 5)');
  console.log('midcap_min_5m_pump:', s.midcap_min_5m_pump, '(expected 3)');
  console.log('midcap_min_1h_pump:', s.midcap_min_1h_pump, '(expected 5)');
} catch (e) {
  console.log('Settings load error:', e.message);
}
