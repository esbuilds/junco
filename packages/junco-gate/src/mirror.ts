// Put another MCP server's tools on a local McpServer so gate() can wrap them: someone else's server, over any transport.
// Arguments pass through (the remote server validates its own); tools/list shows the remote server's own schemas.
// A call that fails mid-flight returns an 'upstream_unavailable' error, never a retry: a write may have landed.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export async function mirror(client: Client | (() => Promise<Client>), name = 'junco-gate-mirror', onFail?: (e: Error) => void) {
  const get = typeof client === 'function' ? client : async () => client;
  const { tools } = await (await get()).listTools();
  const server = new McpServer({ name, version: '1.0.0' });
  for (const t of tools)
    server.registerTool(t.name, { description: t.description, inputSchema: z.object({}).passthrough() }, async (args: any) => {
      try { return (await (await get()).callTool({ name: t.name, arguments: args })) as any; }
      catch (e: any) {
        onFail?.(e);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: { type: 'upstream_unavailable', message: `The upstream MCP server didn't answer (${e.message}). Not retried; check before trying again.` } }) }] };
      }
    });
  // ponytail: _requestHandlers is private SDK state (checked on @modelcontextprotocol/sdk 1.32.1); re-check on upgrade
  const schemas = new Map(tools.map((t) => [t.name, t.inputSchema]));
  const handlers: Map<string, (req: any, extra: any) => Promise<any>> = (server.server as any)._requestHandlers;
  const list = handlers.get('tools/list')!;
  handlers.set('tools/list', async (req, extra) => {
    const r = await list(req, extra);
    return { ...r, tools: r.tools.map((t: any) => (schemas.has(t.name) ? { ...t, inputSchema: schemas.get(t.name) } : t)) };
  });
  return { server, tools };
}
