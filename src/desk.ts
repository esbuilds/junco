// Dispute desk: a small web app over the gated MCP server. Every action goes through the same gate an AI agent hits.
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, sandboxCtx } from './server.js';
import { paypal } from './disputes.js';
import { recommend, collectEvidence, gatherFromPayPal, type Recommendation } from './recommend.js';
import { readHolds } from './gate.js';

const ctx = await sandboxCtx();
const { server, holds } = await createServer(ctx);
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const mcp = new Client({ name: 'desk', version: '0' });
await mcp.connect(b);
const callTool = async (name: string, args: any) =>
  JSON.parse(((await mcp.callTool({ name, arguments: args })) as any).content[0].text);

// ponytail: recommendations cached in one JSON file so reloading the page doesn't re-bill Claude
const RECS = '.junco/recs.json';
type Saved = { recommendation: Recommendation | null; problems: string[]; at: string };
const readRecs = (): Record<string, Saved> => { try { return JSON.parse(readFileSync(RECS, 'utf8')); } catch { return {}; } };
const saveRec = (id: string, r: Saved) => { mkdirSync('.junco', { recursive: true }); writeFileSync(RECS, JSON.stringify({ ...readRecs(), [id]: r }, null, 2)); };

const getDispute = async (id: string) => {
  const r = await paypal(ctx, 'GET', `/v1/customer/disputes/${encodeURIComponent(id)}`);
  if (r.status !== 200) throw Object.assign(new Error(`PayPal ${r.status} loading ${id}`), { code: r.status });
  return r.body;
};
const allowedOf = (d: any) => (d.links ?? []).map((l: any) => l.rel).filter((r: string) => r !== 'self');
const holdsFor = (id: string) => readHolds().filter((h) => h.args?.dispute_id === id);

function row(d: any) {
  const rec = readRecs()[d.dispute_id];
  return {
    id: d.dispute_id, reason: d.reason, amount: Number(d.dispute_amount?.value), currency: d.dispute_amount?.currency_code,
    status: d.status, stage: d.dispute_life_cycle_stage, opened: d.create_time,
    due: d.seller_response_due_date ?? null, buyer_due: d.buyer_response_due_date ?? null,
    allowed: allowedOf(d), decision: rec?.recommendation?.decision ?? null, problems: rec?.problems?.length ?? 0,
    pending_holds: holdsFor(d.dispute_id).filter((h) => h.status === 'pending').length,
  };
}

// Recommendation -> one gated tool call. Contest uses the tracking PayPal already has on the order.
async function act(id: string, rec: Recommendation, message?: string) {
  if (rec.decision === 'wait') return { error: { message: 'JUNCO recommends no PayPal action right now' } };
  if (rec.decision === 'message') return callTool('send_dispute_message', { dispute_id: id, message: message ?? rec.message_to_buyer });
  if (rec.decision === 'offer') {
    const d = await getDispute(id);
    return callTool('make_dispute_offer', { dispute_id: id, offer_type: 'REFUND', offer_amount: { currency_code: d.dispute_amount.currency_code, value: rec.offer_amount }, note: message ?? rec.message_to_buyer ?? rec.summary });
  }
  // ponytail: stock accept_dispute_claim rejects notes with spaces (toolkit 1.11 bug, see PLAN.md), so the note is one token
  if (rec.decision === 'accept') return callTool('accept_dispute_claim', { dispute_id: id, note: 'accepted_by_owner_via_junco' });
  const d = await getDispute(id);
  if (!allowedOf(d).includes('provide_evidence')) // under PayPal review: supporting info is the only way to make the case
    return callTool('provide_dispute_supporting_info', { dispute_id: id, notes: [rec.summary, ...rec.claims.map((c) => c.text)].join(' ').slice(0, 2000) });
  const tracker = (await gatherFromPayPal(ctx, d)).map((e) => e.text.match(/^Tracking (\S+)/)?.[1]).find(Boolean);
  if (rec.evidence_type === 'PROOF_OF_FULFILLMENT' && !tracker) return { error: { message: 'No tracking on the PayPal order to submit as proof of fulfillment' } };
  return callTool('provide_dispute_evidence', {
    dispute_id: id, evidence_type: rec.evidence_type ?? 'OTHER', notes: rec.summary,
    ...(tracker && { carrier_name: 'USPS', tracking_number: tracker }), // ponytail: carrier hardcoded until trackers expose it
  });
}

const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = async (req: IncomingMessage) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };
const STATIC: Record<string, [string, string]> = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/vendor/ag-grid.js': ['node_modules/ag-grid-community/dist/ag-grid-community.min.js', 'text/javascript'],
};

// Hosted desks must set DESK_PASSWORD: the desk can approve actions that move money.
const PASSWORD = process.env.DESK_PASSWORD;
if (process.env.RENDER && !PASSWORD) throw new Error('DESK_PASSWORD must be set on a hosted desk');
const authorized = (req: IncomingMessage) => {
  if (!PASSWORD) return true; // ponytail: local dev only; any non-local deploy sets DESK_PASSWORD
  const [scheme, value] = (req.headers.authorization ?? '').split(' ');
  return scheme === 'Basic' && Buffer.from(value ?? '', 'base64').toString().split(':').slice(1).join(':') === PASSWORD;
};

httpServer(async (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); } // for the host's health check, no data
  if (!authorized(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="JUNCO desk"' }); return res.end('Password required'); }
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'Content-Type': type }); return res.end(readFileSync(file));
    }
    if (req.method === 'GET' && url.pathname === '/api/cases') {
      const list = await paypal(ctx, 'GET', '/v1/customer/disputes?page_size=50');
      const ids: string[] = (list.body.items ?? []).map((d: any) => d.dispute_id);
      return json(res, 200, (await Promise.all(ids.map(getDispute))).map(row));
    }
    if (p[0] === 'api' && p[1] === 'cases' && p[2]) {
      const id = p[2];
      if (req.method === 'GET' && !p[3]) {
        const d = await getDispute(id);
        const evidence = collectEvidence(d, await gatherFromPayPal(ctx, d));
        return json(res, 200, { ...row(d), evidence, saved: readRecs()[id] ?? null, holds: holdsFor(id) });
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
        return json(res, 200, await act(id, saved.recommendation, typeof message === 'string' && message.trim() ? message.trim().slice(0, 2000) : undefined));
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/holds') return json(res, 200, readHolds().filter((h) => h.status === 'pending'));
    if (req.method === 'POST' && p[0] === 'api' && p[1] === 'holds' && (p[3] === 'approve' || p[3] === 'reject'))
      return json(res, 200, await holds[p[3]](p[2]));
    json(res, 404, { error: { message: 'Not found' } });
  } catch (e: any) {
    json(res, e.code === 404 ? 404 : 500, { error: { message: e.message } });
  }
}).listen(Number(process.env.PORT ?? 3000), () => console.log(`JUNCO desk on http://localhost:${process.env.PORT ?? 3000}`));
