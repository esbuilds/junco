// Dispute desk: a small web app over the gated MCP server. Every action goes through the same gate an AI agent hits.
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, sandboxCtx } from './server.js';
import { paypal } from './disputes.js';
import { recommend, collectEvidence, gatherFromPayPal } from './recommend.js';
import { readHolds, type Hold } from './gate.js';
import { makeAgent, readRecs, saveRec, readActivity, allowedOf } from './agent.js';

const ctx = await sandboxCtx();
const DESK_URL = process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

// "My phone buzzed": one Slack-compatible webhook call per new hold. Off unless HOLD_WEBHOOK_URL is set.
async function notifyHold(h: Hold) {
  const url = process.env.HOLD_WEBHOOK_URL;
  if (!url) return;
  try {
    const d = h.args?.dispute_id ? (await paypal(ctx, 'GET', `/v1/customer/disputes/${encodeURIComponent(h.args.dispute_id)}`)).body : {};
    const amount = h.args?.offer_amount ? `${h.args.offer_amount.value} ${h.args.offer_amount.currency_code}` : d.dispute_amount ? `${d.dispute_amount.value} ${d.dispute_amount.currency_code}` : 'n/a';
    const what = h.method.replace(/_/g, ' ');
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      text: `JUNCO is holding *${what}* on ${h.args?.dispute_id ?? 'a dispute'} (${amount}) for your OK.\nWhy: ${h.reason}\nApprove or reject: ${DESK_URL}`,
    }) });
    if (!r.ok) console.warn('[notify] webhook returned', r.status);
  } catch (e: any) { console.warn('[notify] failed', e.message); }
}

const { server, holds } = await createServer(ctx, undefined, (h) => void notifyHold(h));
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const mcp = new Client({ name: 'desk', version: '0' });
await mcp.connect(b);
const callTool = async (name: string, args: any) =>
  JSON.parse(((await mcp.callTool({ name, arguments: args })) as any).content[0].text);
const agent = makeAgent(ctx, callTool);
const AGENT_MODE = process.env.AGENT_MODE === 'on';

const holdsFor = (id: string) => readHolds().filter((h) => h.args?.dispute_id === id);
function row(d: any) {
  const rec = readRecs()[d.dispute_id];
  return {
    id: d.dispute_id, reason: d.reason, amount: Number(d.dispute_amount?.value), currency: d.dispute_amount?.currency_code,
    status: d.status, stage: d.dispute_life_cycle_stage, channel: d.dispute_channel ?? null, opened: d.create_time,
    due: d.seller_response_due_date ?? null, buyer_due: d.buyer_response_due_date ?? null,
    allowed: allowedOf(d), decision: rec?.recommendation?.decision ?? null, problems: rec?.problems?.length ?? 0,
    pending_holds: holdsFor(d.dispute_id).filter((h) => h.status === 'pending').length,
  };
}

const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readRaw = async (req: IncomingMessage, limit = 1_000_000) => {
  let s = '';
  for await (const c of req) { s += c; if (s.length > limit) throw Object.assign(new Error('Body too large'), { code: 413 }); }
  return s;
};
const readBody = async (req: IncomingMessage) => { const s = await readRaw(req); return s ? JSON.parse(s) : {}; };
// The AG Studio desk (studio/, built on deploy) is the main page when its build exists; the original page stays at /classic.
// If the studio build is missing, / falls back to the original page so a failed build never leaves the desk blank.
const STUDIO = 'studio/dist';
const hasStudio = existsSync(`${STUDIO}/index.html`);
const TYPES: Record<string, string> = { js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', woff2: 'font/woff2', png: 'image/png' };
const STATIC: Record<string, [string, string]> = {
  '/': hasStudio ? [`${STUDIO}/index.html`, 'text/html; charset=utf-8'] : ['public/index.html', 'text/html; charset=utf-8'],
  '/classic': ['public/index.html', 'text/html; charset=utf-8'],
  '/vendor/ag-grid.js': ['node_modules/ag-grid-community/dist/ag-grid-community.min.js', 'text/javascript'],
};
// Vite's hashed assets, listed once at startup so request paths never reach the filesystem.
if (hasStudio) for (const f of readdirSync(`${STUDIO}/assets`)) STATIC[`/assets/${f}`] = [`${STUDIO}/assets/${f}`, TYPES[f.split('.').pop()!] ?? 'application/octet-stream'];
const gz = new Map<string, Buffer>(); // ponytail: in-memory gzip cache, a few MB for the studio bundle

// Hosted desks must set DESK_PASSWORD: the desk can approve actions that move money.
const PASSWORD = process.env.DESK_PASSWORD;
if (process.env.RENDER && !PASSWORD) throw new Error('DESK_PASSWORD must be set on a hosted desk');
const authorized = (req: IncomingMessage) => {
  if (!PASSWORD) return true; // ponytail: local dev only; any non-local deploy sets DESK_PASSWORD
  const [scheme, value] = (req.headers.authorization ?? '').split(' ');
  return scheme === 'Basic' && Buffer.from(value ?? '', 'base64').toString().split(':').slice(1).join(':') === PASSWORD;
};

// PayPal webhooks: open endpoint (PayPal can't send our password), so every event is verified with PayPal first.
async function webhook(req: IncomingMessage, res: ServerResponse) {
  const event = JSON.parse(await readRaw(req, 200_000));
  const publicUrl = process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/webhooks/paypal` : '';
  if (!(await agent.verifyWebhook(req.headers, event, publicUrl))) {
    console.warn('[webhook] rejected unverified event', event?.id);
    return json(res, 400, { error: { message: 'Unverified webhook' } });
  }
  json(res, 200, { ok: true }); // answer PayPal now; triage can take minutes
  const id = event.resource?.dispute_id;
  if (AGENT_MODE && typeof id === 'string' && String(event.event_type).startsWith('CUSTOMER.DISPUTE.'))
    agent.triage(id, event.event_type).catch((e) => console.error('[agent]', e));
}

httpServer(async (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); } // for the host's health check, no data
  try {
    if (req.method === 'POST' && req.url === '/webhooks/paypal') return await webhook(req, res);
  } catch (e: any) { return json(res, e.code === 413 ? 413 : 400, { error: { message: 'Bad webhook' } }); }
  if (!authorized(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="JUNCO desk"' }); return res.end('Password required'); }
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const headers: Record<string, string> = { 'Content-Type': type };
      if (url.pathname.startsWith('/assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      if (/gzip/.test(String(req.headers['accept-encoding'] ?? ''))) {
        if (!gz.has(file)) gz.set(file, gzipSync(readFileSync(file)));
        res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }); return res.end(gz.get(file));
      }
      res.writeHead(200, headers); return res.end(readFileSync(file));
    }
    if (req.method === 'GET' && url.pathname === '/api/cases') {
      const list = await paypal(ctx, 'GET', '/v1/customer/disputes?page_size=50');
      const ids: string[] = (list.body.items ?? []).map((d: any) => d.dispute_id);
      return json(res, 200, (await Promise.all(ids.map(agent.getDispute))).map(row));
    }
    if (req.method === 'GET' && url.pathname === '/api/activity') return json(res, 200, { agent_mode: AGENT_MODE, items: readActivity().slice(-50).reverse() });
    if (p[0] === 'api' && p[1] === 'cases' && p[2]) {
      const id = p[2];
      if (req.method === 'GET' && !p[3]) {
        const d = await agent.getDispute(id);
        const evidence = collectEvidence(d, await gatherFromPayPal(ctx, d));
        return json(res, 200, { ...row(d), evidence, saved: readRecs()[id] ?? null, holds: holdsFor(id), activity: readActivity().filter((x) => x.dispute_id === id).reverse() });
      }
      if (req.method === 'POST' && p[3] === 'recommend') {
        const { delivery_scan } = await readBody(req);
        const extra = delivery_scan ? [{ source: 'carrier delivery scan (entered by merchant)', text: String(delivery_scan).slice(0, 500) }] : [];
        const out = await recommend(ctx, id, extra);
        const saved = { recommendation: out.recommendation, problems: out.problems, at: new Date().toISOString() };
        saveRec(id, saved);
        return json(res, 200, { ...saved, evidence: out.evidence });
      }
      if (req.method === 'POST' && p[3] === 'act') {
        const saved = readRecs()[id];
        if (!saved?.recommendation) return json(res, 400, { error: { message: 'Get a recommendation first' } });
        if (saved.problems.length) return json(res, 400, { error: { message: 'Recommendation failed checks', problems: saved.problems } });
        const { message } = await readBody(req);
        return json(res, 200, await agent.act(id, saved.recommendation, typeof message === 'string' && message.trim() ? message.trim().slice(0, 2000) : undefined));
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/holds') return json(res, 200, readHolds().filter((h) => h.status === 'pending'));
    if (req.method === 'POST' && p[0] === 'api' && p[1] === 'holds' && (p[3] === 'approve' || p[3] === 'reject'))
      return json(res, 200, await holds[p[3]](p[2]));
    json(res, 404, { error: { message: 'Not found' } });
  } catch (e: any) {
    json(res, e.code === 404 ? 404 : 500, { error: { message: e.message } });
  }
}).listen(Number(process.env.PORT ?? 3000), () => console.log(`JUNCO desk on http://localhost:${process.env.PORT ?? 3000}${AGENT_MODE ? ' (agent mode on)' : ''}`));

if (AGENT_MODE) { // backup for webhooks that never arrive
  const run = () => agent.sweep().catch((e) => console.error('[agent] sweep', e));
  setTimeout(run, 5_000);
  setInterval(run, 10 * 60_000);
}
