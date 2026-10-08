// Runnable check against the PayPal sandbox, through the real MCP server.
// ERP: provide_evidence already used, send_message still allowed. PBO: no merchant actions left.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, sandboxCtx } from './server.js';

const ERP = 'PP-R-ERP-10190210', PBO = 'PP-R-PBO-10190474';
const [a, b] = InMemoryTransport.createLinkedPair();
const { server } = await createServer(await sandboxCtx(), { default: 'allow', tools: {} }); // gate tested in check-gate.ts
await server.connect(a);
const client = new Client({ name: 'check', version: '0' });
await client.connect(b);

const call = async (name: string, args: any) => {
  const r: any = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  try { return JSON.parse(text); } catch { return { raw: text, isError: r.isError }; }
};

const names = (await client.listTools()).tools.map((t) => t.name);
for (const n of ['get_dispute', 'accept_dispute_claim', 'provide_dispute_evidence', 'make_dispute_offer', 'send_dispute_message', 'provide_dispute_supporting_info'])
  assert(names.includes(n), `missing tool ${n}`);
console.log('tools:', names.length, 'registered, stock + JUNCO');

let r = await call('provide_dispute_evidence', { dispute_id: ERP, evidence_type: 'PROOF_OF_FULFILLMENT', notes: 'shipped' });
assert.equal(r.error?.type, 'invalid_arguments'); console.log('evidence without tracking -> rejected locally');

r = await call('provide_dispute_evidence', { dispute_id: ERP, evidence_type: 'PROOF_OF_FULFILLMENT', carrier_name: 'USPS', tracking_number: '9400100000000000000000', notes: 'Delivered per USPS.' });
assert.equal(r.error?.type, 'action_not_allowed'); console.log('evidence twice -> blocked by HATEOAS, allowed:', r.allowed_actions);

r = await call('make_dispute_offer', { dispute_id: PBO, offer_type: 'REFUND', offer_amount: { currency_code: 'USD', value: '5' }, note: 'x' });
assert.equal(r.error?.type, 'action_not_allowed'); console.log('offer on closed-out case -> blocked, status:', r.status);

if (process.argv.includes('--write')) { // posts a real message to the buyer; off by default so the demo dispute stays clean
  r = await call('send_dispute_message', { dispute_id: ERP, message: 'JUNCO check: tracking shows delivered.' });
  assert.equal(r.ok, true, JSON.stringify(r)); console.log('send message -> PayPal', r.status);
} else console.log('send message -> skipped (run with -- --write)');

r = await call('accept_dispute_claim', { dispute_id: PBO, note: 'Item lost in transit' });
console.log('stock accept_dispute_claim with a normal note ->', JSON.stringify(r).slice(0, 240));

await client.close();
console.log('ok');
