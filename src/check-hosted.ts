// M4 check: PayPal's hosted MCP server behind the gate. Every hosted tool must have a class in policy.json, hidden tools
// must not be listed, PayPal's own schemas must be listed, a read goes through, an accept is held, JUNCO's offer tool is
// added on top. Uses PBO; the accept is held and then rejected, never approved, and PayPal doesn't allow offers on PBO.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadPolicy, toolClass } from './gate.js';
import { createHostedServer, hosted } from './hosted.js';
import { sandboxCtx } from './server.js';

const policy = loadPolicy();
const ctx = await sandboxCtx();
const { tools: remote } = await hosted();
const unclassified = remote.filter((t) => policy.tools[t.name] === undefined).map((t) => t.name);
assert.deepEqual(unclassified, [], `classify these in policy.json: ${unclassified}`);
const counts: Record<string, number> = {};
for (const t of remote) { const c = toolClass(policy, t.name); counts[c] = (counts[c] ?? 0) + 1; }
console.log(`PayPal hosted: ${remote.length} tools, all classified:`, counts);

const { server, holds } = await createHostedServer(ctx, policy);
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: 'check-hosted', version: '0' });
await client.connect(b);
const listed = (await client.listTools()).tools;
const names = new Set(listed.map((t) => t.name));
assert(!names.has('pay_order') && !names.has('delete_invoice'), 'hidden tools must not be listed');
assert(names.has('accept_dispute_claim') && names.has('make_dispute_offer'), 'PayPal accept plus JUNCO offer');
const accept = listed.find((t) => t.name === 'accept_dispute_claim')!;
assert.deepEqual(accept.inputSchema, remote.find((t) => t.name === 'accept_dispute_claim')!.inputSchema, "PayPal's schema is listed");
console.log(`listed ${listed.length} (hidden ones left out); accept_dispute_claim shows PayPal's own schema`);

const call = async (name: string, args: any) => ((await client.callTool({ name, arguments: args })) as any).content[0].text as string;
const PBO = 'PP-R-PBO-10190474';
assert.match(await call('get_dispute', { id: PBO }), /PBO|dispute/i);
console.log('get_dispute (PayPal hosted, read) -> ran');
let r = JSON.parse(await call('accept_dispute_claim', { dispute_id: PBO, note: 'check' }));
assert.equal(r.held, true); console.log('accept_dispute_claim (PayPal hosted) -> held', r.hold_id, '|', r.reason);
await holds.reject(r.hold_id);
r = JSON.parse(await call('make_dispute_offer', { dispute_id: PBO, offer_type: 'REFUND', offer_amount: { currency_code: 'USD', value: '10' }, note: 'check' }));
assert.equal(r.error?.type, 'action_not_allowed'); console.log('make_dispute_offer $10 (JUNCO, on top) -> allowed by the gate, reached PayPal check:', r.error.message);
const refused = await call('pay_order', { id: 'x' }).catch((e) => e.message);
assert.match(refused, /disabled/); console.log('pay_order (not exposed) ->', refused);
await client.close();
console.log('ok');
process.exit(0);
