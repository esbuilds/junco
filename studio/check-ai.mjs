// Reliability check for AG Studio's AI assistant on the Desk: asks the scripted question in a fresh browser N times
// (default 10) and counts the runs that produced a correct widget. Bar: no more than 1 miss in 10.
// A run passes when a chart by dispute lands on the Desk, filtered to JUNCO says Accept, and the answer names every
// open dispute JUNCO says to accept (the same rule as the At risk panel). Needs a desk built with STUDIO_AI=1.
//   npm run check-studio-ai            10 runs against http://localhost:5173
//   DESK=https://... npm run check-studio-ai 3
import { chromium } from 'playwright';
import { tmpdir } from 'node:os';

const DESK = process.env.DESK ?? 'http://localhost:5173';
const RUNS = Number(process.argv[2] ?? 10);
const QUESTION = 'Which disputes am I about to lose this week?';
const httpCredentials = process.env.DESK_PASSWORD ? { username: 'judge', password: process.env.DESK_PASSWORD } : undefined;

const browser = await chromium.launch();
const results = [];
for (let n = 1; n <= RUNS; n++) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, httpCredentials });
  const p = await ctx.newPage();
  let inflight = 0, last = Date.now();
  const mine = (r) => r.url().includes('/api/studio-ai');
  p.on('request', (r) => { if (mine(r)) { inflight++; last = Date.now(); } });
  for (const ev of ['requestfinished', 'requestfailed']) p.on(ev, (r) => { if (mine(r)) { inflight--; last = Date.now(); } });
  await p.goto(DESK);
  await p.waitForFunction(() => window.__studio, null, { timeout: 60000 });
  const expected = await p.evaluate(async () => (await (await fetch('/api/cases')).json())
    .filter((r) => r.status !== 'RESOLVED' && r.decision === 'accept').map((r) => r.id));
  const desk = () => p.evaluate(() => window.__studio.getState().pages.find((x) => x.id === 'desk'));
  const before = Object.keys((await desk()).widgets);
  const close = p.getByRole('button', { name: 'Close' });
  if (await close.isVisible()) await close.click(); // the Start here panel opens on first visit
  const t0 = Date.now();
  let timedOut = false;
  await p.getByText(QUESTION).last().click();
  // Done: at least one model call, none in flight, and 15 s of quiet (Studio pauses between agents). Cap 4 minutes.
  while (!(await p.evaluate(() => window.__studioUsage.calls)) || inflight || Date.now() - last < 15000) {
    if (Date.now() - t0 > 240000) { timedOut = true; break; }
    await p.waitForTimeout(500);
  }
  const seconds = Math.round((last - t0) / 1000);
  const state = await desk();
  const added = Object.keys(state.widgets).filter((i) => !before.includes(i)).map((i) => state.widgets[i]);
  const chart = added.find((w) => /chart/.test(w.type) && JSON.stringify(w.dataMapping ?? {}).includes('disputes.dispute'));
  const filter = JSON.stringify(state.filter ?? {});
  const answer = await p.evaluate(() => document.body.innerText);
  const why = timedOut ? ['still working after 4 minutes'] : [];
  if (!chart) why.push(added.length ? `added ${added.map((w) => w.type).join(', ')}, no chart by dispute` : 'no widget added');
  if (chart && !(filter.includes('junco_says') && filter.includes('Accept'))) why.push('chart not filtered to Accept');
  const missing = expected.filter((id) => !answer.includes(id));
  if (missing.length) why.push(`answer misses ${missing.join(', ')}`);
  const usage = await p.evaluate(() => window.__studioUsage);
  const shot = `${tmpdir()}/junco-check-ai-${n}.png`;
  await p.screenshot({ path: shot });
  results.push({ ok: !why.length, seconds, ...usage });
  console.log(`run ${n}: ${why.length ? 'MISS (' + why.join('; ') + ')' : 'ok'}, ${seconds}s, ${usage.calls} calls, ` +
    `${usage.input} in (${usage.cached} cached, ${usage.cacheWrite} written), ${usage.output} out  ${shot}`);
  await ctx.close();
}
await browser.close();

const ok = results.filter((r) => r.ok).length;
const avg = (k) => Math.round(results.reduce((s, r) => s + r[k], 0) / results.length);
console.log(`\n${ok}/${RUNS} correct. Average ${avg('seconds')}s, ${avg('calls')} calls, ${avg('input')} input tokens (${avg('cached')} cached), ${avg('output')} output tokens per question.`);
process.exit(RUNS - ok <= Math.floor(RUNS / 10) ? 0 : 1);
