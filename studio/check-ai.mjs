// Reliability check for AG Studio's AI assistant on the Desk: asks one question in a fresh browser N times (default 10)
// and counts the runs that got it right. Bar: no more than 1 miss in 10. Needs a desk built with STUDIO_AI=1.
//   npm run check-studio-ai                 10 runs of the scripted question (lose) against http://localhost:5173
//   npm run check-studio-ai 3 explain       3 runs of another question: lose, explain, whatif, open
//   DESK=https://... npm run check-studio-ai 3
import { chromium } from 'playwright';
import { tmpdir } from 'node:os';

try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch {} // DESK_PASSWORD for the hosted desk; real env vars win
const DESK = process.env.DESK ?? 'http://localhost:5173';
const RUNS = Number(process.argv[2] ?? 10);
const httpCredentials = process.env.DESK_PASSWORD ? { username: 'judge', password: process.env.DESK_PASSWORD } : undefined;

// Each question: how it is asked (a starter button, or typed), and what makes the run correct.
// `f` is what the run left behind: widgets added, page filters, the assistant panel's text, JUNCO tool calls, case data.
const QUESTIONS = {
  // The open disputes JUNCO says to Accept, as a chart filtered to Accept, every one named in the answer.
  lose: {
    starter: 'Which disputes am I about to lose this week?',
    judge(f) {
      const why = [];
      const chart = f.added.find((w) => /chart/.test(w.type) && JSON.stringify(w.dataMapping ?? {}).includes('disputes.dispute'));
      if (!chart) why.push(f.added.length ? `added ${f.added.map((w) => w.type).join(', ')}, no chart by dispute` : 'no widget added');
      if (chart && !(f.filter.includes('junco_says') && f.filter.includes('Accept'))) why.push('chart not filtered to Accept');
      const missing = f.accept.filter((id) => !f.panel.includes(id));
      if (missing.length) why.push(`answer misses ${missing.join(', ')}`);
      return why;
    },
  },
  // JUNCO's reasoning on a case comes from its own tool, not a guess.
  explain: {
    typed: (f) => `Why does JUNCO say Accept on ${f.accept[0]}?`,
    judge(f) {
      const call = f.calls.find((c) => c.name === 'junco_explain_case');
      return !call ? ['never read the case'] : call.args.dispute_id !== f.accept[0] ? [`read ${call.args.dispute_id} instead`] : [];
    },
  },
  // The what-if numbers come from the gate replay, and the answer quotes them.
  whatif: {
    typed: () => 'If I raised my auto-offer limit to $60, how many of my cases would JUNCO handle without asking me?',
    judge(f) {
      const call = f.calls.find((c) => c.name === 'junco_policy_what_if');
      if (!call) return ['never ran the what-if'];
      if (Number(call.args.offer_limit) !== 60) return [`ran it at ${call.args.offer_limit}`];
      // Any wording, but the replay's numbers: handled, and either the total or how many stay held.
      const { handled, total } = f.whatIf, has = (n) => new RegExp(`\\b${n}\\b`).test(f.panel);
      return has(handled) && (has(total) || has(total - handled)) ? [] : [`answer lacks ${handled} handled of ${total}`];
    },
  },
  // The case opens in the Case panel.
  open: {
    typed: (f) => `Open ${f.accept[0]} for me.`,
    judge: (f) => (f.calls.some((c) => c.name === 'junco_open_case') && !f.body.includes('Pick a case in the queue') ? [] : ['case not opened']),
  },
};
const NAME = process.argv[3] ?? 'lose';
const Q = QUESTIONS[NAME];
if (!Q) { console.error(`Questions: ${Object.keys(QUESTIONS).join(', ')}`); process.exit(2); }

const browser = await chromium.launch();
const results = [];
for (let n = 1; n <= RUNS; n++) {
  // Each run is its own visitor for the local dev shim's question cap; the hosted desk caps by IP regardless.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, httpCredentials, extraHTTPHeaders: { 'x-visitor': `check-${Date.now()}-${n}` } });
  const p = await ctx.newPage();
  let inflight = 0, last = Date.now();
  const sent = [];
  const mine = (r) => r.url().includes('/api/studio-ai');
  p.on('request', (r) => { if (mine(r)) { inflight++; last = Date.now(); sent.push(r.postData()); } });
  for (const ev of ['requestfinished', 'requestfailed']) p.on(ev, (r) => { if (mine(r)) { inflight--; last = Date.now(); } });
  await p.goto(DESK);
  await p.waitForFunction(() => window.__studio, null, { timeout: 60000 });
  const f = await p.evaluate(async () => {
    const accept = (await (await fetch('/api/cases')).json()).filter((r) => r.status !== 'RESOLVED' && r.decision === 'accept').map((r) => r.id);
    const policy = await (await fetch('/api/policy')).json();
    const whatIf = await (await fetch('/api/policy/what-if', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...policy, offer_limit: 60 }) })).json();
    return { accept, whatIf };
  });
  const desk = () => p.evaluate(() => window.__studio.getState().pages.find((x) => x.id === 'desk'));
  const before = Object.keys((await desk()).widgets);
  const close = p.getByRole('button', { name: 'Close' });
  if (await close.isVisible()) await close.click(); // the Start here panel opens on first visit
  const t0 = Date.now();
  let timedOut = false;
  if (Q.starter) await p.getByText(Q.starter).last().click();
  else { await p.getByPlaceholder('Ask the AI Assistant...').fill(Q.typed(f)); await p.keyboard.press('Enter'); }
  // Done: at least one model call, none in flight, and 15 s of quiet (Studio pauses between agents). Cap 4 minutes.
  while (!(await p.evaluate(() => window.__studioUsage.calls)) || inflight || Date.now() - last < 15000) {
    if (Date.now() - t0 > 240000) { timedOut = true; break; }
    await p.waitForTimeout(500);
  }
  const seconds = Math.round((last - t0) / 1000);
  const state = await desk();
  f.added = Object.keys(state.widgets).filter((i) => !before.includes(i)).map((i) => state.widgets[i]);
  f.filter = JSON.stringify(state.filter ?? {});
  f.body = await p.evaluate(() => document.body.innerText);
  // The assistant panel alone, so IDs elsewhere on the Desk don't count as the answer.
  f.panel = await p.evaluate(() => {
    let el = document.querySelector('textarea[placeholder="Ask the AI Assistant..."]');
    while (el && !el.innerText?.includes('AI Assistant')) el = el.parentElement;
    return el?.innerText ?? '';
  });
  // JUNCO tool calls, read from the conversation Studio sent with each model turn.
  f.calls = [...new Map(sent.flatMap((b) => (JSON.parse(b ?? '{}').input ?? []).filter((i) => i.type === 'function_call' && i.name.startsWith('junco_'))
    .map((i) => [i.callId, { name: i.name, args: JSON.parse(i.arguments || '{}') }]))).values()];
  const why = [...(timedOut ? ['still working after 4 minutes'] : []), ...Q.judge(f)];
  const usage = await p.evaluate(() => window.__studioUsage);
  const shot = `${tmpdir()}/junco-check-ai-${NAME}-${n}.png`;
  await p.screenshot({ path: shot });
  results.push({ ok: !why.length, seconds, ...usage });
  console.log(`run ${n}: ${why.length ? 'MISS (' + why.join('; ') + ')' : 'ok'}, ${seconds}s, ${usage.calls} calls, ` +
    `${usage.input} in (${usage.cached} cached, ${usage.cacheWrite} written), ${usage.output} out  ${shot}`);
  if (why.length) console.log(`  answer: ${f.panel.split('\n').filter(Boolean).slice(-4).join(' / ').slice(0, 400)}`);
  await ctx.close();
}
await browser.close();

const ok = results.filter((r) => r.ok).length;
const avg = (k) => Math.round(results.reduce((s, r) => s + r[k], 0) / results.length);
console.log(`\n${ok}/${RUNS} correct. Average ${avg('seconds')}s, ${avg('calls')} calls, ${avg('input')} input tokens (${avg('cached')} cached), ${avg('output')} output tokens per question.`);
process.exit(RUNS - ok <= Math.floor(RUNS / 10) ? 0 : 1);
