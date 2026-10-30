// The drill, offline: a stand-in PayPal behind the real planter on a local port. The planter keeps to its side of the wall
// (imports nothing from the desk or the gate, and no desk code calls /plant), its caps hold, a plant answers sealed, and
// only the token opens the answer. Nothing here reaches the network: anything but 127.0.0.1 and the stand-in throws.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plant, PlantAnswer } from './drill-types.js';

// The wall, read from the source.
const source = (f: string) => readFileSync(f, 'utf8');
const code = (f: string) => source(f).split('\n').filter((l) => !l.trimStart().startsWith('//')).map((l) => l.replace(/\s\/\/ .*$/, '')).join('\n'); // comments may name the route
const planterSrc = source('src/planter.ts');
const imports = [...planterSrc.matchAll(/^import .*? from '([^']+)';$/gm)].map((m) => m[1]);
assert.deepEqual(imports.filter((i) => i.startsWith('.')), ['./drill-types.js'], 'the planter may import only the shared types from this repo');
assert.ok(/^import type \{ Plant, PlantAnswer \} from '.\/drill-types.js';$/m.test(planterSrc));
assert.ok(!imports.some((i) => /agent-toolkit|modelcontextprotocol|anthropic/.test(i)), 'the planter holds no toolkit, MCP or model client');
assert.ok(!/import\(/.test(code('src/planter.ts')), 'the planter loads nothing at run time');
assert.equal([...planterSrc.matchAll(/https:\/\/[\w.-]*paypal\.com/g)].map((m) => m[0]).join(), 'https://api-m.sandbox.paypal.com', 'the sandbox is the one PayPal host in the planter');
assert.ok(!/PAYPAL_(BASE|API|URL|ENV)/.test(planterSrc), 'the PayPal base comes from no environment variable');
const others = readdirSync('src').filter((f) => f.endsWith('.ts') && f !== 'planter.ts' && f !== 'check-drill.ts').map((f) => `src/${f}`);
for (const f of [...others, ...readdirSync('studio/src').filter((x) => /\.tsx?$/.test(x)).map((x) => `studio/src/${x}`)]) {
  assert.ok(!/\/plant\b/.test(code(f)), `${f} names the plant route: the desk never calls it`);
  assert.ok(!/from '\.\/planter|import\('\.\/planter/.test(code(f)), `${f} imports the planter`);
}
console.log('wall: the planter imports only drill-types, the sandbox is its one PayPal host, no desk code names /plant or imports the planter');

// A stand-in PayPal. Every call must be to the sandbox; a refund needs a request id and a real amount.
const SANDBOX = 'https://api-m.sandbox.paypal.com';
type Cap = { status: string; value: string };
const caps: Record<string, Cap> = {};
const refunds: { capture: string; value: number; requestId: string }[] = [];
let refuse: string | null = null, drop: string | null = null, seq = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const u = new URL(String(input));
  if (u.hostname === '127.0.0.1') return realFetch(input, init);
  assert.equal(u.origin, SANDBOX, `the planter called ${u.origin}`);
  if (u.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'stand-in' });
  const m = u.pathname.match(/^\/v2\/payments\/captures\/(\w+)(\/refund)?$/);
  const c = m && caps[m[1]];
  if (!c) return new Response('{}', { status: 404 });
  if (!m![2]) return Response.json({ id: m![1], status: c.status, amount: { value: c.value, currency_code: 'USD' } });
  if (m![1] === drop) throw new Error('connection dropped');
  if (m![1] === refuse) return Response.json({ name: 'UNPROCESSABLE_ENTITY' }, { status: 422 });
  const body = JSON.parse(init.body), value = Number(body.amount.value);
  assert.match(body.amount.value, /^\d+\.\d\d$/);
  assert.equal(body.amount.currency_code, 'USD');
  const requestId = init.headers['PayPal-Request-Id'];
  assert.ok(requestId, 'a refund carries a PayPal-Request-Id');
  assert.ok(!refunds.some((r) => r.requestId === requestId), 'each refund has its own request id');
  refunds.push({ capture: m![1], value, requestId });
  return Response.json({ id: `REFUND${String(++seq).padStart(11, '0')}`, status: 'COMPLETED', amount: body.amount });
}) as any;

const CAP_A = 'AAAAAAAAAAAAAAAA1', CAP_B = 'BBBBBBBBBBBBBBBB2', CAP_D = 'DDDDDDDDDDDDDDDD3';
process.chdir(mkdtempSync(join(tmpdir(), 'junco-drill-')));
delete process.env.DATABASE_URL;
Object.assign(process.env, { DRILL_TOKEN: 'drill-token-check', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', DESK_ORIGIN: 'https://desk.example',
  DRILL_CAPTURES: `${CAP_A}:INCIDENTAAAAAAAA1,${CAP_D}:INCIDENTDDDDDDDD3,${CAP_B}:INCIDENTBBBBBBBB2` });
const reset = (list: unknown[] = []) => { mkdirSync('.planter', { recursive: true }); writeFileSync('.planter/plants.json', JSON.stringify(list)); return load(); };
const { handler, load, drillCaptures } = await import('./planter.js');
assert.throws(() => drillCaptures('nonsense'), /capture:incident/);
assert.deepEqual(drillCaptures(`${CAP_A}:X1, ${CAP_B}:X2`).map((c) => c.incident_id), ['X1', 'X2']);

const server = createServer((req, res) => void handler(req, res));
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const post = (ip: string, headers: Record<string, string> = {}) => fetch(`${base}/plant`, { method: 'POST', headers: { 'x-forwarded-for': ip, ...headers } });
const open = (kind: string, id: string, token?: string) => fetch(`${base}/${kind}/${id}`, { headers: token ? { 'x-drill-token': token } : {} });
const TOKEN = 'drill-token-check';

Object.assign(caps, { [CAP_A]: { status: 'COMPLETED', value: '62.00' }, [CAP_B]: { status: 'PARTIALLY_REFUNDED', value: '38.00' }, [CAP_D]: { status: 'PENDING', value: '62.00' } });

// A plant: sealed, on a purchase with room, not on a disputed one; only the token opens the answer.
const first = await post('1.1.1.1');
assert.equal(first.status, 200);
const plant = (await first.json()) as Plant;
assert.deepEqual(Object.keys(plant).sort(), ['at', 'capture_id', 'id', 'incident_id'], 'a plant says no amount and no refund id');
assert.equal(refunds.length, 1);
assert.notEqual(refunds[0].capture, CAP_D, 'a disputed capture is never planted on');
assert.ok(refunds[0].value >= 0.5 && refunds[0].value <= 2.5, `amount ${refunds[0].value}`);
assert.equal(plant.capture_id, refunds[0].capture);
assert.equal(plant.incident_id, plant.capture_id === CAP_A ? 'INCIDENTAAAAAAAA1' : 'INCIDENTBBBBBBBB2');
for (const leak of ['REFUND', 'USD', String(refunds[0].value)]) assert.ok(!JSON.stringify(plant).includes(leak), `the plant leaks ${leak}`);
for (const t of [undefined, 'wrong', `${TOKEN}x`]) for (const k of ['reveal', 'sealed']) assert.equal((await open(k, plant.id, t)).status, 403, `${k} opened with token ${t}`);
const sealedPlant = await (await open('sealed', plant.id, TOKEN)).json();
assert.deepEqual(sealedPlant, plant, '/sealed gives the plant and nothing more');
const answer = (await (await open('reveal', plant.id, TOKEN)).json()) as PlantAnswer;
assert.deepEqual(Object.keys(answer).sort(), ['amount', 'plant_id', 'refund_id', 'status']);
assert.equal(answer.plant_id, plant.id);
assert.equal(answer.amount, `${refunds[0].value.toFixed(2)} USD`);
assert.equal(answer.status, 'COMPLETED');
assert.equal((await open('reveal', 'no-such-plant', TOKEN)).status, 404);
assert.deepEqual(await (await fetch(`${base}/count`)).json(), { hidden: 1 });
console.log('plant: sealed, a sandbox refund with a request id from $0.50 to $2.50, never on a disputed capture; only the token opens the answer');

// CORS: only the desk's origin. A browser elsewhere gets no header and no refund.
const before = refunds.length;
const preflight = await fetch(`${base}/plant`, { method: 'OPTIONS', headers: { origin: 'https://desk.example' } });
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://desk.example');
const away = await post('2.2.2.2', { origin: 'https://elsewhere.example' });
assert.equal(away.status, 403);
assert.equal(away.headers.get('access-control-allow-origin'), null);
assert.equal(refunds.length, before);
assert.equal((await fetch(`${base}/plant`, { method: 'OPTIONS', headers: { origin: 'https://elsewhere.example' } })).status, 403);
assert.equal((await post('3.3.3.3', { origin: 'https://desk.example' })).headers.get('access-control-allow-origin'), 'https://desk.example');
for (const [m, p] of [['GET', '/plant'], ['POST', '/reveal/x'], ['DELETE', '/plant'], ['GET', '/']]) assert.equal((await fetch(`${base}${p}`, { method: m })).status, 404, `${m} ${p}`);
console.log('cors: the desk\'s origin only; other origins get no header and no refund');

// Caps. Per IP, per day, per capture, and yesterday's don't count.
const stored = (i: number, ip: string, capture = CAP_A, cents = 100, at = new Date().toISOString()) =>
  ({ id: `p${i}`, at, capture_id: capture, incident_id: 'I', ip, cents, answer: { plant_id: `p${i}`, refund_id: 'R', amount: '1.00 USD', status: 'COMPLETED' } });
await reset();
for (let i = 0; i < 3; i++) assert.equal((await post('4.4.4.4')).status, 200, `plant ${i + 1} from one IP`);
const capped = await post('4.4.4.4');
assert.equal(capped.status, 429);
assert.match(((await capped.json()) as any).error.message, /3 hidden refunds/);
assert.equal((await post('5.5.5.5')).status, 200, 'another IP still has room');

const hash = (ip: string) => createHash('sha256').update(ip).digest('hex').slice(0, 24);
await reset(Array.from({ length: 10 }, (_, i) => stored(i, `ip${i}`)));
const atDay = refunds.length, day = await post('6.6.6.6');
assert.equal(day.status, 429);
assert.match(((await day.json()) as any).error.message, /10 refunds a day/);
assert.equal(refunds.length, atDay);
await reset(Array.from({ length: 10 }, (_, i) => stored(i, hash('6.6.6.6'), CAP_A, 10, '2026-01-01T00:00:00.000Z')));
assert.equal((await post('6.6.6.6')).status, 200, 'yesterday\'s plants don\'t count against today');

await reset([stored(1, 'old', CAP_A, 3000, '2026-01-01T00:00:00.000Z')]);
const res = await post('7.7.7.7');
assert.equal(res.status, 200);
assert.equal(((await res.json()) as Plant).capture_id, CAP_B, '$30 on one capture moves on to the next');
await reset([stored(1, 'old', CAP_A, 3000, '2026-01-01T00:00:00.000Z'), stored(2, 'old', CAP_B, 3000, '2026-01-01T00:00:00.000Z')]);
const blocked = await post('7.7.7.7');
assert.equal(blocked.status, 429, 'the last one with room is disputed');
assert.match(((await blocked.json()) as any).error.message, /can take a refund/);
await reset([stored(1, 'old', CAP_A, 3000, '2026-01-01T00:00:00.000Z'), stored(2, 'old', CAP_B, 3000, '2026-01-01T00:00:00.000Z'), stored(3, 'old', CAP_D, 3000, '2026-01-01T00:00:00.000Z')]);
const full = await post('7.7.7.7');
assert.equal(full.status, 429);
assert.match(((await full.json()) as any).error.message, /\$30/);
await reset([stored(1, 'old', CAP_A, 3000, '2026-01-01T00:00:00.000Z'), stored(2, 'old', CAP_B, 3000, '2026-01-01T00:00:00.000Z')]);
caps[CAP_D].status = 'COMPLETED'; // the disputed one settled: it has room, so it takes the next
const fromD = await post('7.7.7.7');
assert.equal(((await fromD.json()) as Plant).capture_id, CAP_D);
caps[CAP_D].status = 'PENDING';

// Room is also what the purchase can take: a small capture stops short of $30.
await reset([stored(1, 'old', CAP_A, 3000, '2026-01-01T00:00:00.000Z'), stored(2, 'old', CAP_B, 3780, '2026-01-01T00:00:00.000Z')]);
const atSmall = refunds.length;
assert.equal((await post('8.8.8.8')).status, 429);
assert.equal(refunds.length, atSmall);
console.log('caps: 3 per IP, 10 a day, $30 a capture or what the capture holds, 429 with a plain reason, and no refund past any of them');

// PayPal said no: not counted, and the next purchase takes it. No answer: it may have landed, so it stays counted and stops.
await reset([stored(1, 'old', CAP_B, 3000, '2026-01-01T00:00:00.000Z')]);
refuse = CAP_A;
assert.equal((await post('9.9.9.9')).status, 429, 'nothing else has room');
refuse = null;
assert.deepEqual(await (await fetch(`${base}/count`)).json(), { hidden: 1 }, 'a refused refund is not counted');
await reset();
drop = CAP_A; caps[CAP_B].status = 'PENDING';
const lost = await post('9.9.9.9');
assert.equal(lost.status, 502);
assert.match(((await lost.json()) as any).error.message, /may or may not/);
drop = null;
const kept = JSON.parse(readFileSync('.planter/plants.json', 'utf8'));
assert.equal(kept.length, 1, 'an unanswered refund stays counted');
assert.equal(kept[0].answer, null);
assert.equal((await open('reveal', kept[0].id, TOKEN)).status, 404, 'no answer to reveal: that run shows as ungraded');
assert.deepEqual(await (await fetch(`${base}/count`)).json(), { hidden: 0 });
caps[CAP_B].status = 'COMPLETED';

// Two presses at once can't both pass a cap.
await reset(Array.from({ length: 9 }, (_, i) => stored(i, `ip${i}`, CAP_A, 10)));
const burst = await Promise.all([post('10.0.0.1'), post('10.0.0.2'), post('10.0.0.3')]);
assert.deepEqual(burst.map((r) => r.status).sort(), [200, 429, 429]);
console.log('refused and lost: a PayPal no isn\'t counted; no answer stays counted and tries nothing else; simultaneous presses queue');

// Answers survive a restart from the file.
await reset();
const again = (await (await post('11.0.0.1')).json()) as Plant;
await load();
assert.equal((await open('reveal', again.id, TOKEN)).status, 200);
console.log('restart: answers reload from the file');

server.close();
console.log('drill: ok');
