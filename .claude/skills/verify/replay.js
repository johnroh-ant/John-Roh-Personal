// Replay a recorded bus trace through the prediction engine and measure
// stability: delay sign flips, trip-match flips, and arrival jitter.
// Usage: node replay.js <tracker.js path> [busName]
const path = require('path');
const T = require(process.argv[2] || path.join(__dirname, '..', '..', '..', 'tracker.js'));
const fs = require('fs');

async function main() {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, 'lts-fresh.json')));
  const [model, dep] = [T.buildLoopModel(site), JSON.parse(fs.readFileSync(path.join(__dirname, 'dep-6467db5ea59bbb100741d7b7.json')))];
  const trips = T.buildTrips(dep, model);
  const rows = fs.readFileSync(path.join(__dirname, 'traces.jsonl'), 'utf8').trim().split('\n')
    .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(r => r && r.lat);
  const byBus = {};
  rows.forEach(r => (byBus[r.name] = byBus[r.name] || []).push(r));
  const busName = process.argv[3];

  for (const [name, pts] of Object.entries(byBus)) {
    if (busName && name !== busName) continue;
    pts.sort((x, y) => x.when - y.when);
    const fixes = {};
    let last = null, flips = 0, tripFlips = 0, jumps = 0, n = 0;
    const log = [];
    for (const p of pts) {
      const bus = { id: p.id, name, lat: p.lat, lng: p.lng, speed: p.speed || 0, when: p.when, showOnMap: true };
      const pred = T.predictions(model, trips, [bus], 'home', fixes, new Date(p.when))[0];
      if (!pred || pred.delaySec === null) { last = null; continue; }
      n++;
      const t = new Date(p.when).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
      log.push(`${t} trip=${T.fmtClock(pred.tripStartMin)} delay=${(pred.delaySec / 60).toFixed(1)}m arr=${T.fmtClock(Math.round(pred.arrivalSec / 60) % 1440)} ${pred.method}`);
      if (last) {
        if (Math.sign(pred.delaySec) !== Math.sign(last.delaySec) && Math.abs(pred.delaySec - last.delaySec) > 240) flips++;
        if (pred.tripStartMin !== last.tripStartMin) tripFlips++;
        if (Math.abs(pred.arrivalSec - last.arrivalSec) > 300) jumps++;
      }
      last = pred;
    }
    console.log(`\n== ${name}: ${n} schedule-method evaluations`);
    console.log(`   delay sign flips (>4min swing): ${flips} | trip-match changes: ${tripFlips} | arrival jumps >5min: ${jumps}`);
    if (process.argv.includes('--log')) console.log(log.join('\n'));
  }
}
main();
