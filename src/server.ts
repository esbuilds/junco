// MCP server: PayPal's stock toolkit plus the JUNCO dispute tools, on one server.
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tools, run, paypal, type Ctx } from './disputes.js';
import type { Decision } from '../packages/junco-gate/src/index.js';
import { gate, loadActivePolicy, type Policy, type Hold } from './gate.js';
import { hydrate } from './persist.js';
import { trackingTool } from './watch.js';
import { addHoldCard } from './holdcard.js';
import { addIncidentTools } from './incident.js';
import { addWhoElseTool } from './whoelse.js';
import { readHolds } from './gate.js';

// The PayPal token renews in-process: on a timer 10 minutes before it expires, on demand when it is that close, and
// after a 401 (ctx.renew). Oct 21: this replaced exiting for a restart every ~9 h, which left a gap for sign-ins.
export async function sandboxCtx(): Promise<Ctx & { readonly accessToken: string; renew: () => Promise<string>; expire: () => void }> {
  try { process.loadEnvFile(); } catch {} // ponytail: .env optional, real env vars win
  const id = process.env.PAYPAL_CLIENT_ID ?? process.env.client_id;
  const secret = process.env.PAYPAL_CLIENT_SECRET ?? process.env.client_secret;
  if (!id || !secret) throw new Error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');
  const baseUrl = 'https://api-m.sandbox.paypal.com'; // ponytail: sandbox only until the gate exists
  let current = { value: '', exp: 0 }, pending: Promise<string> | null = null, timer: NodeJS.Timeout | undefined;
  const renew = () => pending ??= (async () => {
    try {
      const r = await fetch(`${baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` },
        body: new URLSearchParams({ grant_type: 'client_credentials' }),
      });
      if (!r.ok) throw new Error(`PayPal token request failed: ${r.status}`);
      const { access_token, expires_in } = (await r.json()) as { access_token: string; expires_in: number };
      current = { value: access_token, exp: Date.now() + expires_in * 1000 };
      clearTimeout(timer);
      timer = setTimeout(() => void renew().catch((e) => console.error('[paypal] token renewal failed, retrying on next call', e.message)),
        Math.max(60, expires_in - 600) * 1000).unref();
      return access_token;
    } finally { pending = null; }
  })();
  await renew();
  const ctx = {
    baseUrl, renew,
    token: async () => (Date.now() > current.exp - 600_000 ? renew() : current.value),
    get accessToken() { return current.value }, // the stock toolkit reads this on every call (createServer)
    expire: () => { current = { value: 'expired-for-a-check', exp: Date.now() + 3600_000 }; }, // check-token only
  };
  return ctx;
}

// JUNCO's dispute write tools (evidence, offer, message, supporting info), which PayPal's toolkits lack.
export function addDisputeTools(server: any, ctx: Ctx) {
  for (const t of tools) {
    server.tool(t.method, t.description, t.parameters.shape, async (arg: any) => ({
      content: [{ type: 'text' as const, text: await run(ctx, t.method, arg) }],
    }));
  }
}

// The gate's re-read before an approval runs.
export const caseReader = (ctx: Ctx) => async (id: string) => {
  const d = await paypal(ctx, 'GET', `/v1/customer/disputes/${id}`);
  if (d.status !== 200) throw new Error(`Could not re-read dispute ${id} (${d.status})`);
  return d.body;
};

export const captureReader = (ctx: Ctx) => async (id: string) => {
  const c = await paypal(ctx, 'GET', `/v2/payments/captures/${encodeURIComponent(id)}`);
  if (c.status !== 200) throw new Error(`Could not re-read payment ${id} (${c.status})`);
  return c.body;
};

let hydrated = false;
export async function createServer(ctx: Ctx & { readonly accessToken: string }, given?: Policy, onHold?: (h: Hold) => void, log?: (d: Decision) => void) {
  if (!hydrated) { // once per process: later servers (one per remote MCP request) share the files the first one restored
    hydrated = true;
    const restored = await hydrate(); // restore holds, recs, agent state and owner policy edits before anything reads them
    if (restored) console.error(`[persist] restored ${restored} state files from Postgres`);
  }
  const policy = given ?? loadActivePolicy(); // the gate reads this object on every call, so desk edits apply live
  const server = new PayPalAgentToolkit({
    accessToken: ctx.accessToken,
    // ponytail: action keys as in @paypal/agent-toolkit 1.11.0 (payments.createRefund, payments.getRefunds, orders.get); the
    // tool names match PayPal's hosted server, so policy.json classes them once (create_refund = hold). Re-check on upgrade.
    configuration: { context: { sandbox: true }, actions: { disputes: { list: true, get: true, create: true }, payments: { createRefund: true, getRefunds: true }, orders: { get: true } } },
  });
  // ponytail: _paypal.paypalClient._accessToken is the toolkit's private state (checked on @paypal/agent-toolkit 1.11);
  // it reads it on every request, so this hands it the live token. Re-check on upgrade.
  Object.defineProperty((server as any)._paypal.paypalClient, '_accessToken', { get: () => ctx.accessToken, set() {}, configurable: true });
  // The toolkit's own tools: renew ahead of expiry first, and retry once after a 401 (PayPal ran nothing).
  for (const t of Object.values((server as any)._registeredTools) as any[]) {
    const h = t.handler;
    t.update({ callback: async (args: any, extra: any) => {
      await ctx.token();
      const r = await h(args, extra);
      if (!ctx.renew || !/"status":401\b/.test(r?.content?.[0]?.text ?? '')) return r;
      await ctx.renew(); return h(args, extra);
    } });
  }
  addDisputeTools(server, ctx);
  server.tool(trackingTool.method, trackingTool.description, trackingTool.parameters.shape, async (arg: any) => ({
    content: [{ type: 'text' as const, text: await trackingTool.run(ctx, arg) }],
  }));
  addHoldCard(server, policy, readHolds); // S3, as on the hosted server
  addIncidentTools(server, (p) => paypal(ctx, 'GET', p)); // BLACK BOX on the toolkit path too: PayPal's hosted calls fail at times (Oct 28), this one doesn't
  addWhoElseTool(server);
  return { server, policy, holds: gate(server, policy, onHold, caseReader(ctx), undefined, log, captureReader(ctx)) }; // gate last, so it wraps every tool
}

if (process.argv[1]?.endsWith('server.ts')) {
  createServer(await sandboxCtx()).then(({ server }) => server.connect(new StdioServerTransport()));
}
