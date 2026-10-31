#!/usr/bin/env node
// junco-gate as a command: an MCP server (stdio) that puts an owner's policy in front of another MCP server's tools.
//   junco-gate --paypal                     PayPal's hosted MCP server (sandbox), behind policy.json
//   junco-gate --toolkit                    PayPal's own local MCP server (@paypal/mcp, run with npx) behind policy.json; the
//                                           same tools as hosted, without the hosted server's outages (paypal/agent-toolkit#119)
//   junco-gate --upstream <url> [--header "Authorization: Bearer ..."]   any MCP server (URL ending /sse = SSE, else HTTP)
//   junco-gate holds                        list held calls
//   junco-gate approve <id> | reject <id>   approve runs exactly the held call, after a re-read (--paypal or --toolkit: refused
//                                           as stale if the dispute or payment moved on); reject sends nothing
// Options: --policy policy.json, --holds .junco/holds.json, --log .junco/gate-log.jsonl, --webhook <Slack incoming URL>.
// --paypal and --toolkit take PAYPAL_SANDBOX_ACCESS_TOKEN (what PayPal's Claude Code plugin uses) or PAYPAL_ACCESS_TOKEN, or
// mint a token from PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET. Logs go to stderr; stdout is MCP.
import { parseArgs } from 'node:util';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { gate, jsonStore, type Policy, type Hold, type GateOptions } from './index.js';
import { mirror } from './mirror.js';
import { paypalDisputeHooks, paypalToken } from './paypal.js';

// @paypal/mcp is PayPal's local MCP server on npm (its latest is 1.8.1 on Oct 31 2026, behind the 1.11 toolkit). Pinned so an
// approval runs the same tool shapes the hold was made against.
const TOOLKIT = '@paypal/mcp@1.8.1';

const { values: o, positionals: [cmd = 'serve', holdId] } = parseArgs({ allowPositionals: true, options: {
  upstream: { type: 'string' }, paypal: { type: 'boolean' }, toolkit: { type: 'boolean' }, header: { type: 'string', multiple: true },
  policy: { type: 'string', default: 'policy.json' }, holds: { type: 'string', default: '.junco/holds.json' },
  log: { type: 'string', default: '.junco/gate-log.jsonl' }, webhook: { type: 'string' }, help: { type: 'boolean', short: 'h' },
} });
const say = (...a: unknown[]) => console.error('[junco-gate]', ...a);
if (o.help || !['serve', 'holds', 'approve', 'reject'].includes(cmd)) {
  console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(o.help ? 0 : 1);
}
const store = jsonStore(o.holds);
if (cmd === 'holds') {
  for (const h of store.read()) console.log(`${h.id}  ${h.status.padEnd(9)} ${h.created.slice(0, 16)}  ${h.method} ${JSON.stringify(h.args).slice(0, 100)}\n          ${h.reason}`);
  process.exit(0);
}
if (cmd === 'reject') { // sends nothing, so it needs no upstream
  const holds = store.read(), h = holds.find((x) => x.id === holdId);
  if (!h || h.status !== 'pending') { console.log(h ? `Hold ${holdId} is already ${h.status}` : `No hold ${holdId}`); process.exit(1); }
  h.status = 'rejected'; store.write(holds);
  console.log(`${h.id} rejected`);
  process.exit(0);
}

const url: string = o.upstream ?? (o.paypal ? 'https://mcp.sandbox.paypal.com/sse' : o.toolkit ? `npx -y ${TOOLKIT}` : '');
if (!url) { say('give --upstream <url>, --paypal or --toolkit'); process.exit(1); }
const policy: Policy = (() => { try { return JSON.parse(readFileSync(o.policy!, 'utf8')); } catch (e: any) { say(`can't read the policy ${o.policy}: ${e.message}`); process.exit(1); } })();

// The PayPal token: the one PayPal's own plugin uses, a plain access token, or one minted from the app's client id and secret.
async function paypalAccess(): Promise<{ token: string; expiresIn: number }> {
  const given = process.env.PAYPAL_SANDBOX_ACCESS_TOKEN ?? process.env.PAYPAL_ACCESS_TOKEN;
  if (given) return { token: given, expiresIn: 3600 };
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('--paypal and --toolkit need PAYPAL_SANDBOX_ACCESS_TOKEN, PAYPAL_ACCESS_TOKEN, or PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');
  return paypalToken(id, secret);
}

// One upstream connection, reopened after it drops or 10 minutes before a PayPal token expires. A call that fails
// mid-flight is reported by mirror() as upstream_unavailable and never retried: a write may have landed.
let conn: Promise<Client> | null = null;
function upstream(): Promise<Client> {
  if (conn) return conn;
  const p = (async () => {
    const headers: Record<string, string> = Object.fromEntries((o.header ?? []).map((h) => [h.slice(0, h.indexOf(':')).trim(), h.slice(h.indexOf(':') + 1).trim()]));
    let env: Record<string, string> | undefined;
    if (o.paypal || o.toolkit) {
      const { token, expiresIn } = await paypalAccess();
      if (o.paypal) headers.Authorization = `Bearer ${token}`;
      else env = { ...(process.env as Record<string, string>), PAYPAL_ACCESS_TOKEN: token, PAYPAL_ENVIRONMENT: 'SANDBOX' };
      setTimeout(() => { if (conn === p) conn = null; }, Math.max(60, expiresIn - 600) * 1000).unref();
    }
    const transport = o.toolkit
      ? new StdioClientTransport({ command: 'npx', args: ['-y', TOOLKIT, '--tools=all'], env, stderr: 'ignore' })
      : url.endsWith('/sse')
      ? new SSEClientTransport(new URL(url), { requestInit: { headers }, eventSourceInit: { fetch: (u: any, i: any) => fetch(u, { ...i, headers: { ...i?.headers, ...headers } }) } as any })
      : new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
    const client = new Client({ name: 'junco-gate', version: '0.2.0' });
    client.onclose = () => { if (conn === p) conn = null; };
    await client.connect(transport);
    return client;
  })();
  conn = p;
  p.catch(() => { if (conn === p) conn = null; });
  return p;
}

const readDispute = async (id: string) => {
  const r: any = await (await upstream()).callTool({ name: 'get_dispute', arguments: { dispute_id: id } });
  return JSON.parse(r.content?.[0]?.text ?? '');
};
// PayPal's MCP servers have no tool that reads a capture, so a held refund's re-read goes to the REST API.
const readCapture = async (id: string) => {
  const { token } = await paypalAccess();
  const r = await fetch(`https://api-m.sandbox.paypal.com/v2/payments/captures/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Could not re-read payment ${id} (${r.status})`);
  return r.json();
};
const notify = (h: Hold) => {
  const line = `Held ${h.method} ${JSON.stringify(h.args).slice(0, 200)}: ${h.reason}. Approve with: junco-gate approve ${h.id}`;
  say(line);
  if (o.webhook) void fetch(o.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: line }) }).catch((e) => say('webhook', e.message));
};
const opts: GateOptions = {
  store, onHold: notify, ...((o.paypal || o.toolkit) && paypalDisputeHooks(readDispute, readCapture, () => store.read())),
  log: (d) => { mkdirSync(dirname(o.log!), { recursive: true }); appendFileSync(o.log!, JSON.stringify(d) + '\n'); },
};

const { server, tools } = await mirror(upstream, 'junco-gate', () => { conn = null; });
const g = gate(server, policy, opts);

if (cmd === 'approve') {
  if (!holdId) { say(`junco-gate ${cmd} <hold id>`); process.exit(1); }
  try {
    const h = await g.approve(holdId);
    console.log(`${h.id} ${h.status}${h.result ? `: ${h.result.slice(0, 400)}` : ''}`);
    process.exit(0);
  } catch (e: any) { console.log(e.message); process.exit(1); }
}
await server.connect(new StdioServerTransport());
const counts = tools.reduce((n: Record<string, number>, t) => { const r = policy.tools[t.name]; const k = r === undefined ? `default ${policy.default}` : typeof r === 'string' ? r : 'limit'; n[k] = (n[k] ?? 0) + 1; return n; }, {});
say(`${url}: ${tools.length} tools behind ${o.policy} (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}). Holds in ${o.holds}.`);
