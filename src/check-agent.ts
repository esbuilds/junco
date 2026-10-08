// Agent check against the sandbox: triage acts once per state, never re-messages a silent buyer, logs everything.
// Costs up to two Claude calls. Uses the real gated MCP server.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, sandboxCtx } from './server.js';
import { makeAgent, readActivity } from './agent.js';

rmSync('.junco/handled.json', { force: true });
const ctx = await sandboxCtx();
const { server } = await createServer(ctx);
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const mcp = new Client({ name: 'check-agent', version: '0' });
await mcp.connect(b);
const callTool = async (name: string, args: any) => JSON.parse(((await mcp.callTool({ name, arguments: args })) as any).content[0].text);
const agent = makeAgent(ctx, callTool, { unlockWaitMs: 1000, unlockTries: 1 });

const steps = (id: string, since: number) => readActivity().slice(since).filter((x) => x.dispute_id === id).map((x) => `${x.step}: ${x.detail}`);

for (const id of ['PP-R-ERP-10190210', 'PP-R-VQB-10190531']) {
  const n = readActivity().length;
  await agent.triage(id, 'check');
  const first = steps(id, n);
  console.log(id, 'first pass ->', first);
  assert(first.length > 0, 'agent should log what it did');
  assert(!first.some((s) => s.startsWith('done: message')), 'must not message a buyer who has not replied');
  const m = readActivity().length;
  await agent.triage(id, 'check-repeat');
  assert.deepEqual(steps(id, m), [], 'unchanged dispute must be skipped without a new recommendation');
  console.log(id, 'second pass -> skipped (state unchanged)');
}
await mcp.close();
console.log('ok');
