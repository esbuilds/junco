#!/usr/bin/env node
// junco-gate as a command: an MCP server (stdio) that puts an owner's policy in front of another MCP server's tools.
//   junco-gate --paypal                     PayPal's hosted MCP server (sandbox), behind policy.json
//   junco-gate --upstream <url> [--header "Authorization: Bearer ..."]   any MCP server (URL ending /sse = SSE, else HTTP)
//   junco-gate holds                        list held calls
//   junco-gate approve <id> | reject <id>   approve runs exactly the held call, after a re-read (--paypal: refused as
//                                           stale if the dispute moved on); reject sends nothing
// Options: --policy policy.json, --holds .junco/holds.json, --log .junco/gate-log.jsonl, --webhook <Slack incoming URL>.
// --paypal reads PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET from the environment. Logs go to stderr; stdout is MCP.
import { parseArgs } from 'node:util';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { gate, jsonStore, type Policy, type Hold, type GateOptions } from './index.js';
import { mirror } from './mirror.js';
import { paypalDisputeHooks, paypalToken } from './paypal.js';

const { values: o, positionals: [cmd = 'serve', holdId] } = parseArgs({ allowPositionals: true, options: {
  upstream: { type: 'string' }, paypal: { type: 'boolean' }, header: { type: 'string', multiple: true },
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

const url: string = o.upstream ?? (o.paypal ? 'https://mcp.sandbox.paypal.com/sse' : '');
if (!url) { say('give --upstream <url> or --paypal'); process.exit(1); }
const policy: Policy = (() => { try { return JSON.parse(readFileSync(o.policy!, 'utf8')); } catch (e: any) { say(`can't read the policy ${o.policy}: ${e.message}`); process.exit(1); } })();

// One upstream connection, reopened after it drops or 10 minutes before a PayPal token expires. A call that fails
// mid-flight is reported by mirror() as upstream_unavailable and never retried: a write may have landed.
let conn: Promise<Client> | null = null;
function upstream(): Promise<Client> {
  if (conn) return conn;
  const p = (async () => {
    const headers: Record<string, string> = Object.fromEntries((o.header ?? []).map((h) => [h.slice(0, h.indexOf(':')).trim(), h.slice(h.indexOf(':') + 1).trim()]));
    if (o.paypal) {
      const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
      if (!id || !secret) throw new Error('--paypal needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');
      const { token, expiresIn } = await paypalToken(id, secret);
      headers.Authorization = `Bearer ${token}`;
      setTimeout(() => { if (conn === p) conn = null; }, Math.max(60, expiresIn - 600) * 1000).unref();
    }
    const transport = url.endsWith('/sse')
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
// PayPal's hosted MCP has no tool that reads a capture, so a held refund's re-read goes to the REST API.
const readCapture = async (id: string) => {
  const { token } = await paypalToken(process.env.PAYPAL_CLIENT_ID!, process.env.PAYPAL_CLIENT_SECRET!);
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
  store, onHold: notify, ...(o.paypal && paypalDisputeHooks(readDispute, readCapture)),
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
