// PayPal's own hosted MCP server (mcp.sandbox.paypal.com), behind JUNCO's gate, with JUNCO's dispute tools added on top.
// PayPal's server has 46 tools but for disputes only list, get and accept; offers, messages and evidence come from JUNCO.
// Every tool, PayPal's and JUNCO's, goes through the same policy.json classes (read, allowed write, hold, not exposed).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Ctx } from './disputes.js';
import { gate, type Policy, type Hold } from './gate.js';
import { mirror } from '../packages/junco-gate/src/mirror.js';
import { addDisputeTools, caseReader } from './server.js';

const HOSTED = 'https://mcp.sandbox.paypal.com/sse'; // ponytail: sandbox only; /mcp and /http are 404 there, SSE works

// The hosted server takes a client-credentials bearer token (verified Oct 9; its OAuth metadata doesn't advertise it).
async function clientToken() {
  const id = process.env.PAYPAL_CLIENT_ID ?? process.env.client_id, secret = process.env.PAYPAL_CLIENT_SECRET ?? process.env.client_secret;
  const r = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
    method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!r.ok) throw new Error(`PayPal token request failed: ${r.status}`);
  const b = (await r.json()) as { access_token: string; expires_in: number };
  return { token: b.access_token, expiresIn: b.expires_in };
}

// One shared connection per process. It reconnects with a fresh token 10 minutes before the token expires, and on the
// next call after the stream drops. A call that fails mid-flight is reported, never retried: a write may have landed.
type Conn = { client: Client; tools: Tool[] };
let conn: Promise<Conn> | null = null;
export function hosted(): Promise<Conn> {
  if (conn) return conn;
  const p: Promise<Conn> = (async () => {
    const { token, expiresIn } = await clientToken();
    const headers = { Authorization: `Bearer ${token}` };
    const transport = new SSEClientTransport(new URL(HOSTED), {
      requestInit: { headers },
      eventSourceInit: { fetch: (u: any, i: any) => fetch(u, { ...i, headers: { ...i?.headers, ...headers } }) } as any,
    });
    const client = new Client({ name: 'junco-gate', version: '1.0.0' });
    client.onclose = () => { if (conn === p) conn = null; };
    await client.connect(transport);
    const { tools } = await client.listTools();
    setTimeout(() => { if (conn === p) conn = null; setTimeout(() => void client.close(), 60_000).unref(); }, // in-flight calls finish
      Math.max(60, expiresIn - 600) * 1000).unref();
    return { client, tools };
  })();
  conn = p;
  p.catch(() => { if (conn === p) conn = null; });
  return p;
}

// PayPal's tools are mirrored onto a local server (junco-gate's mirror: pass-through arguments, PayPal's own schemas in
// tools/list, a mid-flight failure reported as upstream_unavailable and never retried), then JUNCO's tools, then the gate.
export async function createHostedServer(ctx: Ctx, policy: Policy, onHold?: (h: Hold) => void) {
  const { server } = await mirror(async () => (await hosted()).client, 'junco-gate-paypal-hosted', () => { conn = null; });
  addDisputeTools(server, ctx);
  const holds = gate(server, policy, onHold, caseReader(ctx), 'paypal-hosted');
  return { server, holds };
}
