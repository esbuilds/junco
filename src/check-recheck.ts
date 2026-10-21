// S4 check, offline (no PayPal call; a stand-in create_refund): webhook news flags pending holds made before it, a refund
// PayPal reports on the same payment refuses the held refund at approval, and later news keeps that refund on the hold.
// Writes check holds (refused or rejected) to the local .junco/holds.json, as check-gate does.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { flagHolds, gate, loadPolicy, readHolds } from './gate.js';

const server = new McpServer({ name: 'check-recheck', version: '0' });
let sent = 0;
server.tool('create_refund', { capture_id: z.string(), amount: z.any() }, async () => { sent++; return { content: [{ type: 'text' as const, text: '{"status":"COMPLETED"}' }] }; });
const holds = gate(server, loadPolicy());
const call = async (args: any) => JSON.parse(((await (server as any)._registeredTools.create_refund.handler(args, {})) as any).content[0].text);

const capture = `CHECK-${randomUUID().slice(0, 8)}`, other = `${capture}-other`;
const held = await call({ capture_id: capture, amount: { value: '5.00', currency_code: 'USD' } });
const untouched = await call({ capture_id: other, amount: { value: '5.00', currency_code: 'USD' } });
assert.equal(held.held, true); assert.equal(untouched.held, true);
const before = new Date(Date.now() - 60_000).toISOString(), now = new Date(Date.now() + 1000).toISOString();

assert.equal(flagHolds({ capture_id: capture }, 'PAYMENT.CAPTURE.REFUNDED', before).length, 0); // news older than the hold
const flagged = flagHolds({ capture_id: capture }, 'PAYMENT.CAPTURE.REFUNDED', now, { id: 'REFUND-1', at: now });
assert.deepEqual(flagged.map((h) => h.id), [held.hold_id]); // only the hold on that payment
assert.equal(flagHolds({ dispute_id: 'PP-R-NONE' }, 'CUSTOMER.DISPUTE.UPDATED', now).length, 0);
flagHolds({ capture_id: capture }, 'PAYMENT.CAPTURE.COMPLETED', now); // later news without a refund
assert.equal(readHolds().find((h) => h.id === held.hold_id)?.recheck?.refund?.id, 'REFUND-1'); // the refund stays
console.log('flag: only pending holds on that payment, only for news after the hold; the reported refund is kept');

await assert.rejects(holds.approve(held.hold_id), /Not run: PayPal reported refund REFUND-1/);
assert.equal(readHolds().find((h) => h.id === held.hold_id)?.status, 'stale');
await holds.reject(untouched.hold_id);
assert.equal(sent, 0);
console.log('approve: a held refund is refused once PayPal reported another refund on its payment; nothing was sent');
console.log('recheck: ok');
