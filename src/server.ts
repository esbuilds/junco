// MCP server: PayPal's stock toolkit plus the JUNCO dispute tools, on one server.
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tools, run, type Ctx } from './disputes.js';
import { gate, loadPolicy, type Policy } from './gate.js';

export async function sandboxCtx(): Promise<Ctx & { accessToken: string }> {
  try { process.loadEnvFile(); } catch {} // ponytail: .env optional, real env vars win
  const id = process.env.PAYPAL_CLIENT_ID ?? process.env.client_id;
  const secret = process.env.PAYPAL_CLIENT_SECRET ?? process.env.client_secret;
  if (!id || !secret) throw new Error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');
  const baseUrl = 'https://api-m.sandbox.paypal.com'; // ponytail: sandbox only until the gate exists
  const r = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!r.ok) throw new Error(`PayPal token request failed: ${r.status}`);
  const { access_token: accessToken, expires_in } = (await r.json()) as { access_token: string; expires_in: number };
  // The stock toolkit server only takes a fixed token, so long-running processes exit 10 min before it
  // expires and the host (Render, or the agent that spawned the MCP server) starts a fresh one.
  // ponytail: ~30s of downtime every ~9h; swap in per-call tokens if the toolkit ever accepts a token provider
  setTimeout(() => { console.error('PayPal token expiring, exiting for restart'); process.exit(75); }, Math.max(60, expires_in - 600) * 1000).unref();
  return { baseUrl, accessToken, token: async () => accessToken };
}

export async function createServer(ctx: Ctx & { accessToken: string }, policy: Policy = loadPolicy()) {
  const server = new PayPalAgentToolkit({
    accessToken: ctx.accessToken,
    configuration: { context: { sandbox: true }, actions: { disputes: { list: true, get: true, create: true } } },
  });
  for (const t of tools) {
    server.tool(t.method, t.description, t.parameters.shape, async (arg: any) => ({
      content: [{ type: 'text' as const, text: await run(ctx, t.method, arg) }],
    }));
  }
  return { server, holds: gate(server, policy) }; // gate last, so it wraps every tool
}

if (process.argv[1]?.endsWith('server.ts')) {
  createServer(await sandboxCtx()).then(({ server }) => server.connect(new StdioServerTransport()));
}
