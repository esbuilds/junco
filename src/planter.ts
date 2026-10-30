// THE DRILL's planter. A separate program with its own process and
// its own Render service: it makes a small sandbox refund straight at PayPal, outside the gate, so a fresh Claude can be sent
// to find it. The desk has no path around the gate and this file must not give it one: it imports nothing from the desk or
// the gate except the shared types, the desk never calls POST /plant (a visitor's browser does), and check-drill pins both.
// POST /plant (public, capped) refunds a random amount on a drill purchase with room left and answers sealed: no amount, no
// refund id. GET /reveal/:id gives the answer and GET /sealed/:id the sealed plant, each with the x-drill-token header; only
// the desk holds it. GET /count is how many are hidden. Answers keep in a file, plus Postgres if DATABASE_URL is set; losing
// them on a restart just means those runs show as ungraded.
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import pg from 'pg';
import type { Plant, PlantAnswer } from './drill-types.js';

try { process.loadEnvFile(); } catch {} // ponytail: .env optional, real env vars win
const SANDBOX = 'https://api-m.sandbox.paypal.com'; // hardcoded, never from the environment: pp() refuses any other origin
const MIN_CENTS = 50, MAX_CENTS = 250, PER_IP = 3, PER_DAY = 10, PER_CAPTURE_CENTS = 3000;
const FILE = '.planter/plants.json';
const DESK = (process.env.DESK_ORIGIN ?? 'https://junco-desk.onrender.com').replace(/\/$/, '');
const TOKEN = process.env.DRILL_TOKEN ?? '';

type Stored = Plant & { ip: string; cents: number; answer: PlantAnswer | null }; // answer null: PayPal's reply never arrived
const REFUNDABLE = ['COMPLETED', 'PARTIALLY_REFUNDED']; // a disputed capture is PENDING: never planted on

// DRILL_CAPTURES: capture:incident pairs, comma separated. A bad pair stops the service: better no drill than the wrong money.
export const drillCaptures = (raw = process.env.DRILL_CAPTURES ?? '') => raw.split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
  if (!/^[A-Z0-9]{17}:[\w-]{1,64}$/.test(pair)) throw new Error(`DRILL_CAPTURES: "${pair}" is not capture:incident`);
  const [capture_id, incident_id] = pair.split(':');
  return { capture_id, incident_id };
});
const DRILL = drillCaptures();

const url = process.env.DATABASE_URL, host = url ? new URL(url).hostname : ''; // TLS as persist.ts: none for internal hostnames
const db = url ? new pg.Pool({ connectionString: url, max: 2, ssl: host.includes('.') && host !== '127.0.0.1' ? { rejectUnauthorized: true } : false }) : null;
let plants: Stored[] = [];

// Restores the file, then anything Postgres has that the file doesn't (Render wipes the disk on deploy).
export async function load() {
  try { plants = JSON.parse(readFileSync(FILE, 'utf8')); } catch { plants = []; }
  if (!db) return;
  await db.query('create table if not exists drill_plants (id text primary key, body jsonb not null)');
  const { rows } = await db.query<{ body: Stored }>('select body from drill_plants');
  plants = [...plants, ...rows.map((r) => r.body).filter((b) => !plants.some((p) => p.id === b.id))];
}
const write = () => { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(plants, null, 2)); };
function save(p: Stored) {
  write();
  void db?.query('insert into drill_plants (id, body) values ($1, $2) on conflict (id) do update set body = excluded.body', [p.id, JSON.stringify(p)])
    .catch((e) => console.error('[planter] save failed', p.id, e.message));
}
function drop(p: Stored) {
  plants = plants.filter((x) => x.id !== p.id);
  write();
  void db?.query('delete from drill_plants where id = $1', [p.id]).catch((e) => console.error('[planter] delete failed', p.id, e.message));
}

async function pp(path: string, init: RequestInit = {}) {
  const u = new URL(path, SANDBOX);
  if (u.origin !== SANDBOX) throw new Error(`refused: ${u.origin} is not the PayPal sandbox`);
  return fetch(u, { ...init, signal: AbortSignal.timeout(15_000) });
}
async function token() {
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await pp('/v1/oauth2/token', { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  if (!r.ok) throw new Error(`token ${r.status}`);
  return ((await r.json()) as any).access_token as string;
}

const sealed = ({ id, at, capture_id, incident_id }: Stored): Plant => ({ id, at, capture_id, incident_id });
const no = (code: number, message: string) => ({ code, body: { error: { message } } });
const cents = (value: unknown) => Math.round(Number(value) * 100);

// One refund. The plant is counted before PayPal is called, so a crash can't get past a cap, and it stays counted unless
// PayPal plainly said no: with no answer the refund may have landed, so nothing else is tried.
async function plant(ip: string) {
  const today = new Date().toISOString().slice(0, 10), todays = plants.filter((p) => p.at.startsWith(today));
  if (todays.length >= PER_DAY) return no(429, `The drill hides ${PER_DAY} refunds a day and today's are used up. It starts again at midnight UTC.`);
  if (todays.filter((p) => p.ip === ip).length >= PER_IP) return no(429, `That's your ${PER_IP} hidden refunds for today. Come back tomorrow.`);
  const spent = (c: string) => plants.filter((p) => p.capture_id === c).reduce((t, p) => t + p.cents, 0);
  const open = DRILL.filter((c) => PER_CAPTURE_CENTS - spent(c.capture_id) >= MIN_CENTS).sort((a, b) => spent(a.capture_id) - spent(b.capture_id));
  if (!open.length) return no(429, DRILL.length ? 'Every drill purchase has had its $30 of hidden refunds.' : 'No drill purchases are listed yet.');
  const auth = { Authorization: `Bearer ${await token()}` };
  for (const c of open) {
    const read = await pp(`/v2/payments/captures/${c.capture_id}`, { headers: auth });
    const cap: any = read.ok ? await read.json() : null;
    if (!cap || !REFUNDABLE.includes(cap.status)) continue;
    const room = Math.min(PER_CAPTURE_CENTS, cents(cap.amount?.value)) - spent(c.capture_id);
    if (room < MIN_CENTS) continue;
    const n = Math.min(randomInt(MIN_CENTS, MAX_CENTS + 1), room);
    const p: Stored = { id: randomUUID(), at: new Date().toISOString(), ...c, ip, cents: n, answer: null };
    plants.push(p); save(p);
    const r = await pp(`/v2/payments/captures/${c.capture_id}/refund`, { method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', 'PayPal-Request-Id': `drill-${p.id}`, Prefer: 'return=representation' },
      body: JSON.stringify({ amount: { value: (n / 100).toFixed(2), currency_code: 'USD' } }) }).catch(() => null);
    if (r && r.status >= 400 && r.status < 500) { drop(p); continue; }
    const b: any = r?.ok ? await r.json().catch(() => null) : null;
    if (!b?.id) return no(502, "PayPal didn't confirm the refund, so it may or may not have gone through. Nothing else was tried.");
    p.answer = { plant_id: p.id, refund_id: String(b.id), amount: `${(n / 100).toFixed(2)} USD`, status: String(b.status) };
    save(p);
    return { code: 200, body: sealed(p) };
  }
  return no(429, 'No drill purchase can take a refund right now.');
}
// ponytail: one plant at a time across the process, so two presses can't both pass a cap; a queue per capture if it ever matters
let line: Promise<unknown> = Promise.resolve();
const inLine = <T>(f: () => Promise<T>): Promise<T> => { const p = line.then(f, f); line = p.catch(() => {}); return p; };

const send = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const tokenOk = (given: unknown) => { const a = Buffer.from(String(given ?? '')), b = Buffer.from(TOKEN); return !!TOKEN && a.length === b.length && timingSafeEqual(a, b); };
const ipOf = (req: IncomingMessage) => createHash('sha256').update(String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0].trim()).digest('hex').slice(0, 24);

export async function handler(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url ?? '/', 'http://x').pathname, origin = req.headers.origin;
  if (origin === DESK) { res.setHeader('Access-Control-Allow-Origin', DESK); res.setHeader('Vary', 'Origin'); }
  if (path === '/healthz') { res.writeHead(200); return res.end(`ok ${(process.env.RENDER_GIT_COMMIT ?? 'local').slice(0, 7)}`); }
  if (req.method === 'GET' && path === '/count') return send(res, 200, { hidden: plants.filter((p) => p.answer).length });
  if (path === '/plant') {
    if (origin && origin !== DESK) return send(res, 403, { error: { message: 'Not from the desk' } });
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Max-Age': '600' }); return res.end(); }
    if (req.method === 'POST') {
      const ip = ipOf(req), r = await inLine(() => plant(ip)).catch((e) => { console.error('[planter]', e.message); return no(502, "PayPal didn't answer. Nothing was hidden."); });
      return send(res, r.code, r.body);
    }
  }
  const m = path.match(/^\/(reveal|sealed)\/([\w-]{1,64})$/);
  if (req.method === 'GET' && m) {
    if (!tokenOk(req.headers['x-drill-token'])) return send(res, 403, { error: { message: 'Drill token required' } });
    const p = plants.find((x) => x.id === m[2]), body = m[1] === 'sealed' ? p && sealed(p) : p?.answer;
    return body ? send(res, 200, body) : send(res, 404, { error: { message: 'No such plant' } });
  }
  send(res, 404, { error: { message: 'Not found' } });
}

if (process.argv[1]?.endsWith('planter.ts')) {
  for (const k of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'DRILL_TOKEN']) if (!process.env[k]) throw new Error(`Set ${k}`);
  await load();
  createServer((req, res) => void handler(req, res).catch((e) => { console.error('[planter]', e.message); send(res, 500, { error: { message: 'Failed' } }); }))
    .listen(Number(process.env.PORT ?? 3100), () => console.log(`JUNCO planter on ${process.env.PORT ?? 3100}, ${DRILL.length} drill purchases, ${plants.length} hidden`));
}
