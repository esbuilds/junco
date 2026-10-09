// Dispute desk: a small web app over the gated MCP server. Every action goes through the same gate an AI agent hits.
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, sandboxCtx } from './server.js';
import { paypal } from './disputes.js';
import { recommend, collectEvidence, gatherFromPayPal } from './recommend.js';
import { readHolds, savePolicy, readBudgets, setBudget, movesMoney, decide as gateDecide, type Hold, type Policy } from './gate.js';
import { makeAgent, readRecs, saveRec, readActivity, allowedOf } from './agent.js';
import { makePlans, readPlans } from './plan.js';
import { allow as tryAllowed, listScenarios, runTry } from './try.js';
import { makeWatch, readOrders, SELLER_PROTECTION_PAGE, trackingTool } from './watch.js';

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

const { server, holds, policy } = await createServer(ctx, undefined, (h) => void notifyHold(h));

// Owner-editable slice of the gate policy: the auto-offer limit and, per money-moving action, run it or hold it.
const AUTO = ['send_dispute_message', 'provide_dispute_evidence', 'provide_dispute_supporting_info', 'accept_dispute_claim', 'create_refund'];
const policyView = () => {
  const offer = policy.tools.make_dispute_offer;
  return { offer_limit: typeof offer === 'object' ? offer.max_amount : 0, ship_within_days: policy.ship_within_days ?? 2, auto: Object.fromEntries(AUTO.map((t) => [t, policy.tools[t] === 'allow'])) };
};
function buildPolicy(body: any): Policy {
  const limit = Number(body?.offer_limit);
  if (!Number.isFinite(limit) || limit < 0 || limit > 500) throw Object.assign(new Error('offer_limit must be between 0 and 500'), { code: 400 });
  const auto = body?.auto ?? {};
  if (Object.keys(auto).some((k) => !AUTO.includes(k) || typeof auto[k] !== 'boolean')) throw Object.assign(new Error('auto takes true/false for known actions only'), { code: 400 });
  const tools: Policy['tools'] = { ...policy.tools, make_dispute_offer: { max_amount: Math.round(limit * 100) / 100, over: 'hold' } };
  for (const t of AUTO) if (t in auto) tools[t] = auto[t] ? 'allow' : 'hold';
  const days = body?.ship_within_days === undefined ? policy.ship_within_days ?? 2 : Number(body.ship_within_days);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw Object.assign(new Error('ship_within_days must be a whole number from 1 to 30'), { code: 400 });
  return { ...policy, tools, ship_within_days: days };
}
const applyPolicy = (body: any) => Object.assign(policy, savePolicy(buildPolicy(body)));

// What-if: replay every saved recommendation through the gate's own decide() under a draft policy. No PayPal calls.
// ponytail: contest counts as provide_dispute_evidence; a case under review would use supporting info, same default rule
const ACTION_TOOL: Record<string, string> = { message: 'send_dispute_message', offer: 'make_dispute_offer', contest: 'provide_dispute_evidence', accept: 'accept_dispute_claim' };
function whatIf(draft: Policy) {
  const budgets = readBudgets();
  const cases = Object.entries(readRecs())
    .filter(([, r]) => r.recommendation && r.recommendation.decision !== 'wait' && !r.problems.length)
    .map(([id, r]) => {
      const rec = r.recommendation!;
      const args = { dispute_id: id, ...(rec.decision === 'offer' && { offer_amount: { currency_code: 'USD', value: rec.offer_amount } }) };
      const { verdict, reason } = gateDecide(draft, ACTION_TOOL[rec.decision], args, budgets);
      return { id, decision: rec.decision, handled: verdict === 'allow', reason };
    });
  return { handled: cases.filter((c) => c.handled).length, total: cases.length, cases };
}
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const mcp = new Client({ name: 'desk', version: '0' });
await mcp.connect(b);
const callTool = async (name: string, args: any) =>
  JSON.parse(((await mcp.callTool({ name, arguments: args })) as any).content[0].text);
const agent = makeAgent(ctx, callTool);
const plans = makePlans({ ctx, callTool, getDispute: agent.getDispute, log: agent.log });
const watch = makeWatch(ctx, () => policy.ship_within_days ?? 2, agent.log);
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
    outcome: d.dispute_outcome?.outcome_code ?? null, refunded: d.dispute_outcome?.amount_refunded ? Number(d.dispute_outcome.amount_refunded.value) : null,
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
  // Shipment watch: a captured payment starts being watched for tracking.
  if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' && typeof event.resource?.id === 'string')
    return void watch.refresh(event.resource.id, event.event_type).catch((e) => console.error('[watch]', e.message));
  const id = event.resource?.dispute_id;
  if (typeof id !== 'string' || !String(event.event_type).startsWith('CUSTOMER.DISPUTE.')) return;
  // An owner-approved plan owns its dispute: it runs even with agent mode off, and the agent stays out so nothing acts twice.
  if (plans.isActive(id)) plans.tick(id, event.event_type).catch((e) => console.error('[plan]', e));
  else if (AGENT_MODE) agent.triage(id, event.event_type).catch((e) => console.error('[agent]', e));
}

httpServer(async (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); } // for the host's health check, no data
  try {
    if (req.method === 'POST' && req.url === '/webhooks/paypal') return await webhook(req, res);
  } catch (e: any) { return json(res, e.code === 413 ? 413 : 400, { error: { message: 'Bad webhook' } }); }
  if (!authorized(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="JUNCO desk"' }); return res.end('Password required'); }
  const url = new URL(req.url ?? '/', 'http://x');
  // Any MCP client (Claude Code, Claude Desktop, other agents) can use the desk's tools over HTTP, behind the same
  // password and the same gate: a held action shows up on this desk for the owner. Stateless: one gated server per request.
  if (url.pathname === '/mcp') {
    try {
      const { server: s } = await createServer(ctx, policy, (h) => { agent.log(h.args?.dispute_id ?? h.args?.order_id ?? 'mcp', 'mcp', 'waiting for you', `${h.method.replace(/_/g, ' ')} from an MCP client: ${h.reason}`); void notifyHold(h); });
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void t.close(); void s.close(); });
      await s.connect(t);
      return await t.handleRequest(req, res, req.method === 'POST' ? JSON.parse((await readRaw(req, 1_000_000)) || '{}') : undefined);
    } catch (e: any) { return json(res, 400, { error: { message: e.message } }); }
  }
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
    if (req.method === 'GET' && url.pathname === '/api/start') {
      // "Start here" for judges, worked out from live state so it never points at something stale.
      const recs = readRecs(), acts = readActivity();
      const hold = readHolds().find((h) => h.status === 'pending' && h.args?.dispute_id);
      const counts = new Map<string, number>();
      for (const a of acts) if (a.dispute_id.startsWith('PP-')) counts.set(a.dispute_id, (counts.get(a.dispute_id) ?? 0) + 1);
      const replay = [...counts].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const refusal = Object.entries(recs).find(([id, r]) => id !== hold?.args?.dispute_id && r.recommendation && ['wait', 'accept'].includes(r.recommendation.decision) && r.recommendation.would_change_mind)?.[0]
        ?? Object.entries(recs).find(([id, r]) => id !== hold?.args?.dispute_id && r.recommendation && ['wait', 'accept'].includes(r.recommendation.decision))?.[0] ?? null;
      return json(res, 200, {
        hold: hold ? { id: hold.id, dispute_id: hold.args.dispute_id, method: hold.method } : null,
        refusal, replay, orders: Object.keys(readOrders()).length,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/activity') return json(res, 200, { agent_mode: AGENT_MODE, items: readActivity().slice(-50).reverse() });
    if (p[0] === 'api' && p[1] === 'cases' && p[2]) {
      const id = p[2];
      if (req.method === 'GET' && !p[3]) {
        const d = await agent.getDispute(id);
        const evidence = collectEvidence(d, await gatherFromPayPal(ctx, d));
        return json(res, 200, { ...row(d), evidence, saved: readRecs()[id] ?? null, budget: readBudgets()[id] ?? null, plan: readPlans()[id] ?? null, holds: holdsFor(id), activity: readActivity().filter((x) => x.dispute_id === id).reverse() });
      }
      if (req.method === 'POST' && p[3] === 'recommend') {
        const { delivery_scan } = await readBody(req);
        const extra = delivery_scan ? [{ source: 'carrier delivery scan (entered by merchant)', text: String(delivery_scan).slice(0, 500) }] : [];
        const before = readRecs()[id];
        const prev = before?.recommendation ? { decision: before.recommendation.decision, summary: before.recommendation.summary, at: before.at } : null;
        const out = await recommend(ctx, id, extra, undefined, prev);
        const saved = { recommendation: out.recommendation, problems: out.problems, at: new Date().toISOString(), previous: prev };
        saveRec(id, saved);
        return json(res, 200, { ...saved, evidence: out.evidence });
      }
      if (p[3] === 'plan') {
        if (req.method === 'POST' && !p[4]) return json(res, 200, await plans.propose(id));
        if (req.method === 'POST' && p[4] === 'approve') return json(res, 200, await plans.approve(id));
        if (req.method === 'DELETE' && !p[4]) return json(res, 200, plans.cancel(id));
      }
      if (p[3] === 'budget' && (req.method === 'PUT' || req.method === 'DELETE')) {
        // "Handle it, up to $N": a standing approval for this dispute only. Pending holds within it run now.
        if (req.method === 'DELETE') { setBudget(id, null); agent.log(id, 'owner', 'approval revoked', 'Standing approval removed; actions go back to the normal policy'); return json(res, 200, { budget: null }); }
        const d = await agent.getDispute(id);
        if (d.status === 'RESOLVED') return json(res, 400, { error: { message: 'This dispute is already resolved' } });
        const amount = Number(d.dispute_amount?.value), limit = Number((await readBody(req)).limit);
        if (!(limit > 0 && limit <= amount)) return json(res, 400, { error: { message: `Limit must be above 0 and at most the disputed ${amount}` } });
        const budget = { limit: Math.round(limit * 100) / 100, amount, currency: d.dispute_amount.currency_code, set_at: new Date().toISOString() };
        setBudget(id, budget);
        agent.log(id, 'owner', 'standing approval', `Owner lets JUNCO handle this dispute on its own up to ${budget.limit} ${budget.currency}`);
        const ran = [];
        for (const h of holdsFor(id).filter((x) => x.status === 'pending' && movesMoney(x.method, x.args, budget) <= budget.limit)) {
          const r = await holds.approve(h.id);
          const failed = /"error"/.test(r.result ?? ''); // tool results are JSON text; PayPal failures carry an error object
          agent.log(id, 'owner', failed ? 'failed' : 'done', `${h.method.replace(/_/g, ' ')} ${failed ? 'failed' : 'ran'} under the standing approval${failed ? `: ${(r.result ?? '').slice(0, 200)}` : ''}`);
          ran.push(r);
        }
        return json(res, 200, { budget, ran });
      }
      if (req.method === 'POST' && p[3] === 'act') {
        const saved = readRecs()[id];
        if (!saved?.recommendation) return json(res, 400, { error: { message: 'Get a recommendation first' } });
        if (saved.problems.length) return json(res, 400, { error: { message: 'Recommendation failed checks', problems: saved.problems } });
        const { message } = await readBody(req);
        return json(res, 200, await agent.act(id, saved.recommendation, typeof message === 'string' && message.trim() ? message.trim().slice(0, 2000) : undefined));
      }
    }
    if (url.pathname === '/api/orders' && req.method === 'GET')
      return json(res, 200, { seller_protection_page: SELLER_PROTECTION_PAGE, items: Object.values(readOrders()).sort((x, y) => y.captured_at.localeCompare(x.captured_at)) });
    if (url.pathname === '/api/orders' && req.method === 'POST') { // watch a capture by hand (one the webhook missed)
      const { capture_id } = await readBody(req);
      if (typeof capture_id !== 'string' || !/^[A-Z0-9]{10,30}$/.test(capture_id)) return json(res, 400, { error: { message: 'capture_id looks wrong' } });
      return json(res, 200, await watch.refresh(capture_id, 'owner'));
    }
    if (p[0] === 'api' && p[1] === 'orders' && p[2] && p[3] === 'track' && req.method === 'POST') {
      const o = readOrders()[p[2]];
      if (!o) return json(res, 404, { error: { message: 'Not a watched order' } });
      const { tracking_number, carrier } = await readBody(req);
      const args = trackingTool.parameters.safeParse({ order_id: o.order_id, capture_id: o.capture_id, tracking_number: String(tracking_number ?? '').replace(/\s/g, ''), carrier });
      if (!args.success) return json(res, 400, { error: { message: 'Pick USPS, UPS, FedEx or DHL and enter the tracking number (letters and digits only)' } });
      const r = await callTool('add_order_tracking', args.data);
      if (!r.ok) return json(res, r.held ? 202 : 400, r);
      return json(res, 200, await watch.refresh(o.capture_id, 'owner'));
    }
    if (url.pathname === '/api/try/scenarios' && req.method === 'GET') return json(res, 200, listScenarios());
    if (url.pathname === '/api/try' && req.method === 'POST') {
      // Scenario mode: synthetic cases only, no PayPal calls. Rate-limited by visitor address (Render sets x-forwarded-for).
      const visitor = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0].trim();
      const limited = tryAllowed(visitor);
      if (limited) return json(res, 429, { error: { message: limited } });
      const out = await runTry(await readBody(req));
      return json(res, out.error ? 400 : 200, out.error ? { error: { message: out.error } } : out);
    }
    if (url.pathname === '/api/policy/what-if' && req.method === 'POST') return json(res, 200, whatIf(buildPolicy(await readBody(req))));
    if (url.pathname === '/api/policy') {
      if (req.method === 'PUT') applyPolicy(await readBody(req));
      else if (req.method === 'DELETE') Object.assign(policy, savePolicy(null)); // reset to the repo default
      else if (req.method !== 'GET') return json(res, 405, { error: { message: 'Method not allowed' } });
      return json(res, 200, policyView());
    }
    if (req.method === 'GET' && url.pathname === '/api/holds') return json(res, 200, readHolds().filter((h) => h.status === 'pending'));
    if (req.method === 'POST' && p[0] === 'api' && p[1] === 'holds' && (p[3] === 'approve' || p[3] === 'reject'))
      return json(res, 200, await holds[p[3]](p[2]));
    json(res, 404, { error: { message: 'Not found' } });
  } catch (e: any) {
    json(res, e.code === 404 || e.code === 400 ? e.code : 500, { error: { message: e.message } });
  }
}).listen(Number(process.env.PORT ?? 3000), () => console.log(`JUNCO desk on http://localhost:${process.env.PORT ?? 3000}${AGENT_MODE ? ' (agent mode on)' : ''}`));

// Watched orders cross their ship-by time without any event, so they are re-checked on a timer too.
setInterval(() => void watch.refreshAll().catch((e) => console.error('[watch]', e)), 10 * 60_000);
// Plans wait on time as well as events ("buyer silent for 48 hours"), so they also run on a timer.
setInterval(() => void plans.tickAll().catch((e) => console.error('[plan]', e)), 10 * 60_000);

if (AGENT_MODE) { // backup for webhooks that never arrive
  const run = () => agent.sweep().catch((e) => console.error('[agent] sweep', e));
  setTimeout(run, 5_000);
  setInterval(run, 10 * 60_000);
}
