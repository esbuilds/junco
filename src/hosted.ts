// PayPal's own hosted MCP server (mcp.sandbox.paypal.com), behind JUNCO's gate, with JUNCO's dispute tools added on top.
// PayPal's server has 46 tools but for disputes only list, get and accept; offers, messages and evidence come from JUNCO.
// Every tool, PayPal's and JUNCO's, goes through the same policy.json classes (read, allowed write, hold, not exposed).
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Ctx } from './disputes.js';
import { gate, type Policy, type Hold } from './gate.js';
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

const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });

export async function createHostedServer(ctx: Ctx, policy: Policy, onHold?: (h: Hold) => void) {
  const { tools } = await hosted();
  const server = new McpServer({ name: 'junco-gate-paypal-hosted', version: '1.0.0' });
  for (const t of tools) {
    // PayPal's server validates its own arguments; ours passes them through and lists PayPal's schema (below).
    server.registerTool(t.name, { description: t.description, inputSchema: z.object({}).passthrough() }, async (args: any) => {
      try { return (await (await hosted()).client.callTool({ name: t.name, arguments: args })) as any; }
      catch (e: any) { conn = null; return text({ error: { type: 'hosted_unavailable', message: `PayPal's hosted MCP server didn't answer (${e.message}). Not retried; check the case before trying again.` } }); }
    });
  }
  addDisputeTools(server, ctx);
  const holds = gate(server, policy, onHold, caseReader(ctx), 'paypal-hosted');
  // tools/list shows PayPal's own input schemas for its tools, not the pass-through one.
  // ponytail: _requestHandlers is private SDK state (checked on @modelcontextprotocol/sdk 1.32.1); re-check on upgrade
  const schemas = new Map(tools.map((t) => [t.name, t.inputSchema]));
  const handlers: Map<string, (req: any, extra: any) => Promise<any>> = (server.server as any)._requestHandlers;
  const list = handlers.get('tools/list')!;
  handlers.set('tools/list', async (req, extra) => {
    const r = await list(req, extra);
    return { ...r, tools: r.tools.map((t: any) => (schemas.has(t.name) ? { ...t, inputSchema: schemas.get(t.name) } : t)) };
  });
  return { server, holds };
}
