// Who else? on the real records, run by hand after a deploy: reads the hosted desk's public incidents (GETs only, no hold, no
// write) and runs the finder three times on each seed, with the owner's note given here. Not in CI: it calls Claude, about $0.05 a run. Spec: docs/superpowers/specs.
//   npm run whoelse-real            both tests   DESK_URL= points it at another desk
//   npm run whoelse-real trial      a proposed correction, then the seed's ask 3 times with it, in a temp folder: no order, nothing kept
// The cohort comes from the records as they stand, so a new purchase or a new dispute needs no edit here.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { correctListing, shop } from './shopper.js';
import { assemble, ask, proposeCorrection, type Finding } from './whoelse.js';
import type { Incident } from './incident-types.js';
import type { Member } from './whoelse-types.js';

try { process.loadEnvFile(); } catch {}
const BASE = (process.env.DESK_URL ?? 'https://junco-desk.onrender.com').replace(/\/$/, '');
const RUNS = 3;
const MATCH = { seed: '5AY65648E56430500', note: 'The agent told the buyer this bag is carry-on friendly, but it is 25 cm deep and many airlines allow 23 cm.' };
const NO_MATCH = { seed: '7CL97543VD124994Y', note: 'The agent told the buyer this bag is waterproof, but the listing says light rain only.' };
const get = async (p: string) => { const r = await fetch(BASE + p, { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(`${p} answered ${r.status}`); return r.json() as any; };
const raw = await get('/api/incidents'), list = raw.incidents ?? raw;
const all: Incident[] = [];
for (const i of list) all.push(await get(`/api/incident/${i.id}`));

const carryOn = (m: Pick<Member, 'sku' | 'instruction'>) => m.sku === 'WKD-01' && /carry-on/i.test(m.instruction);
const badQuotes = (f: Finding, inc: Incident[]) => {
  const by = new Map(inc.map((i) => [i.id, i])), of = (i: Incident | undefined, field: string) => (field === 'instruction' ? i?.authority?.instruction : (i?.purchase as any)?.[field]) ?? '';
  return f.verdicts.flatMap((v) => v.quotes.filter((q) => !q.text.trim() || !of(by.get(v.id), q.field).includes(q.text)).map((q) => `${v.id}: ${q.text}`));
};
if (process.argv[2] === 'trial') {
  process.chdir(mkdtempSync(join(tmpdir(), 'junco-whoelse-trial-'))); // the correction and the spend meter stay here
  const seed = all.find((i) => i.id === MATCH.seed)!, fix = await proposeCorrection(MATCH.note, seed);
  if (!fix) throw new Error('no proposal');
  console.log(`proposed for ${seed.purchase!.sku}: ${fix.text}`);
  correctListing(seed.purchase!.sku, fix.text);
  for (let n = 1; n <= RUNS; n++) console.log(`trial ${n}:`, JSON.stringify(await shop(seed.authority!.instruction, parseFloat(seed.authority!.budget).toFixed(2))));
  process.exit(0);
}
let usd = 0, failed = 0;
const line = (ms: Member[]) => Object.entries(ms.reduce<Record<string, number>>((t, m) => ({ ...t, [m.bucket]: (t[m.bucket] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ');

async function run({ seed: seedId, note }: typeof MATCH, n: number, judge: (ms: Member[], f: Finding) => string[]) {
  const seed = all.find((i) => i.id === seedId);
  if (!seed) throw new Error(`no incident ${seedId}`);
  const others = all.filter((i) => i !== seed), t = Date.now();
  const { finding, usd: u } = await ask(note, seed, others);
  usd += u;
  const { cause, members } = assemble(note, seed, others, finding), wrong = [...judge(members, finding), ...badQuotes(finding, all).map((q) => `quote not word for word: ${q}`)];
  if (wrong.length) failed++;
  console.log(`${seedId} run ${n}: ${wrong.length ? 'FAIL' : 'pass'} $${u.toFixed(3)} ${((Date.now() - t) / 1000).toFixed(0)}s | ${line(members)} | seed is ${members[0].bucket}`);
  for (const q of cause.quotes) console.log(`  seed quote (${q.field}): ${q.text}`);
  wrong.forEach((w) => console.log(`  ${w}`));
  return members;
}

// A note that fits: every WKD-01 carry-on purchase on the desk shows it, and nothing else does.
const match = (ms: Member[]) => ms.flatMap((m) => {
  const want = !carryOn(m) ? ['not_same'] : m.dispute_id ? ['complained'] : ['silent', 'repaired'];
  return want.includes(m.bucket) ? [] : [`${m.incident_id} ${m.sku || 'decline'} is ${m.bucket}, wanted ${want.join(' or ')}: ${m.why}`];
});
// A note no other record backs: the agent never called anything waterproof when it bought, so no other purchase comes back same.
const noMatch = (_: Member[], f: Finding) => f.verdicts.filter((v) => v.id !== NO_MATCH.seed && v.verdict !== 'not_same').map((v) => `${v.id} came back ${v.verdict}: ${v.why} | ${v.quotes.map((q) => `${q.field}: ${q.text}`).join(' | ')}`);

const cohort = all.filter((i) => i.purchase?.sku === 'WKD-01' && /carry-on/i.test(i.authority?.instruction ?? ''));
console.log(`${all.length} incidents, ${cohort.length} WKD-01 carry-on purchases (${cohort.filter((i) => i.dispute_id).length} disputed), ${all.filter((i) => !i.purchase).length} declines`);
for (let n = 1; n <= RUNS; n++) await run(MATCH, n, match);
for (let n = 1; n <= RUNS; n++) await run(NO_MATCH, n, noMatch);
console.log(`${failed ? 'FAILED' : 'PASSED'}: ${RUNS * 2 - failed} of ${RUNS * 2} runs, $${usd.toFixed(2)}`);
process.exit(failed ? 1 : 0);
