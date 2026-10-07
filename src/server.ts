// MCP server: PayPal's stock toolkit plus the JUNCO dispute tools, on one server.
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tools, run, type Ctx } from './disputes.js';

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
  const accessToken = (await r.json()).access_token as string;
  // ponytail: one token per process; refresh when servers run longer than its ~9h lifetime
  return { baseUrl, accessToken, token: async () => accessToken };
}

export async function createServer(ctx: Ctx & { accessToken: string }) {
  const server = new PayPalAgentToolkit({
    accessToken: ctx.accessToken,
    configuration: { context: { sandbox: true }, actions: { disputes: { list: true, get: true, create: true } } },
  });
  for (const t of tools) {
    server.tool(t.method, t.description, t.parameters.shape, async (arg: any) => ({
      content: [{ type: 'text' as const, text: await run(ctx, t.method, arg) }],
    }));
  }
  return server;
}

if (process.argv[1]?.endsWith('server.ts')) {
  createServer(await sandboxCtx()).then((s) => s.connect(new StdioServerTransport()));
}
