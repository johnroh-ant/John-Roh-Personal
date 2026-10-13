// Field recorder for the live Trakk feed (the same data the app polls).
//
//   node .claude/skills/verify/record.js <out.jsonl> <end time with zone> [--max-minutes 100]
//
// Every 5 s: one JSON line per device per distinct GPS fix (all routes),
// appended to <out.jsonl> — the format groundtruth.js reads. Every 15 min:
// the feed's departure data (signed image URLs scrubbed, as in the committed
// fixtures), appended to <out>-departures.jsonl only when it changed;
// `groundtruth.js --dep` reads that file. Stops at the end time or after
// --max-minutes, whichever is first, so a long recording runs as resumable
// chunks; on restart it skips fixes the file already has. The last line
// printed is a JSON summary ("done": true once the end time is reached).
// Exits 1 without recording if the first polls all fail (feed blocked).
// Errors go to <out>.err. Uses curl so the session's HTTPS proxy applies.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const T = require(path.join(__dirname, '..', '..', '..', 'tracker.js'));
const args = process.argv.slice(2);
const OUT = args[0];
const endArg = args[1] || '';
const maxIdx = args.indexOf('--max-minutes');
const MAX_MIN = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 100;
function usage(msg) {
  console.error((msg ? msg + '\n' : '') +
    'usage: record.js <out.jsonl> <end time, e.g. 2026-10-13T20:35:00-07:00> [--max-minutes N]');
  process.exit(2);
}
// an end time without a zone would be read as the container's UTC
if (!OUT || !/(Z|[+-]\d\d:\d\d)$/.test(endArg)) usage('the end time needs an explicit zone (Z or an offset like -07:00)');
const END = new Date(endArg).getTime();
if (!Number.isFinite(END)) usage('bad end time');
if (!(MAX_MIN > 0)) usage('--max-minutes must be positive');
const resuming = fs.existsSync(OUT) && fs.statSync(OUT).size > 0;
if (!resuming && END <= Date.now()) usage('the end time has already passed');
const STOP = Math.min(END, Date.now() + MAX_MIN * 60000);
const DEP_OUT = OUT.replace(/\.jsonl$/, '') + '-departures.jsonl';
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });

// fetch() stand-in for tracker.js's own fetchLiveSite / fetchDepartures
function curlFetch(url, opts) {
  const headers = Object.entries((opts && opts.headers) || {}).flatMap(([k, v]) => ['-H', k + ': ' + v]);
  return new Promise((resolve, reject) => {
    execFile('curl', ['-sS', '--max-time', '8', '-w', '\n%{http_code}'].concat(headers, [url]),
      { encoding: 'utf8', maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop()));
        const i = stdout.lastIndexOf('\n');
        const status = Number(stdout.slice(i + 1));
        const body = stdout.slice(0, i);
        resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve().then(() => JSON.parse(body)) });
      });
  });
}
function logErr(e) {
  try { fs.appendFileSync(OUT + '.err', new Date().toISOString() + ' ' + String(e && e.message) + '\n'); } catch (e2) { /* nowhere to log */ }
}

// resume: fixes already on disk are not written again; a line cut short by
// a killed run is closed off so the next record starts on its own line
const seen = new Set();
if (resuming) {
  const txt = fs.readFileSync(OUT, 'utf8');
  for (const l of txt.split('\n')) {
    try { const r = JSON.parse(l); seen.add(r.id + ':' + r.when); } catch (e) { /* partial line */ }
  }
  if (!txt.endsWith('\n')) fs.appendFileSync(OUT, '\n');
}
let lastDepHash = null;
if (fs.existsSync(DEP_OUT)) {
  const lines = fs.readFileSync(DEP_OUT, 'utf8').trim().split('\n');
  try { lastDepHash = JSON.parse(lines[lines.length - 1]).sha1; } catch (e) { /* none yet */ }
}

const stats = { added: 0, polls: 0, errors: 0, departureSnapshots: 0 };
const devices = new Set();
async function pollLive() {
  const site = await T.fetchLiveSite(curlFetch);
  const now = Date.now();
  stats.polls++;
  for (const d of (site.liveTrackingSite || {}).devices || []) {
    if (!d.deviceUpdate) continue;
    const b = T.normalizeDevice(d);
    const k = b.id + ':' + b.when;
    if (seen.has(k)) continue;
    fs.appendFileSync(OUT, JSON.stringify({ poll: now, id: b.id, name: b.name, online: b.online, show: b.showOnMap,
      route: b.routeId, lat: b.lat, lng: b.lng, speed: b.speed, heading: b.heading, when: b.when }) + '\n');
    seen.add(k);
    devices.add(b.id);
    stats.added++;
  }
}
async function pollDepartures() {
  const data = await T.fetchDepartures(curlFetch);
  // signed image URLs differ per request and must not be committed
  (Array.isArray(data) ? data : []).forEach(loop => ((loop && loop.stops) || []).forEach(s => {
    if (s && 'imageUrl' in s) s.imageUrl = null;
  }));
  const sha1 = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex');
  if (sha1 === lastDepHash) return;
  fs.appendFileSync(DEP_OUT, JSON.stringify({ poll: Date.now(), sha1, data }) + '\n');
  lastDepHash = sha1;
  stats.departureSnapshots++;
}

function finish(code, extra) {
  console.log(JSON.stringify(Object.assign({ done: Date.now() >= END, totalFixes: seen.size,
    devicesThisChunk: devices.size }, stats, extra || {}, { stoppedAt: new Date().toISOString() })));
  process.exit(code);
}
process.on('SIGTERM', () => finish(0, { signal: 'SIGTERM' }));
process.on('SIGINT', () => finish(0, { signal: 'SIGINT' }));

(async () => {
  let nextDep = 0, everOk = false, failsInARow = 0;
  while (Date.now() < STOP) {
    try { await pollLive(); everOk = true; failsInARow = 0; } catch (e) { stats.errors++; failsInARow++; logErr(e); }
    // blocked feed (the default cloud environment gets a proxy 403): stop
    // instead of logging failures for the whole chunk
    if (!everOk && failsInARow >= 6) finish(1, { aborted: 'the first 6 polls all failed; see ' + OUT + '.err' });
    if (Date.now() >= nextDep) {
      nextDep = Date.now() + 15 * 60000;
      try { await pollDepartures(); } catch (e) { stats.errors++; logErr(e); }
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  finish(0);
})();
