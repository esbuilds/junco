// Token renewal check, reads only: an expired PayPal token (forced) is renewed on the 401 and the call retried once,
// for JUNCO's own PayPal calls and for the stock toolkit's tools, with no restart.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { paypal } from './disputes.js';
import { createServer, sandboxCtx } from './server.js';

const ctx = await sandboxCtx();
ctx.expire();
const r = await paypal(ctx, 'GET', '/v1/customer/disputes?page_size=1');
assert.equal(r.status, 200, `JUNCO call after a forced expiry answered ${r.status}`);
assert.ok(ctx.accessToken !== 'expired-for-a-check', 'the token was not renewed'); // never compare tokens in an assert: it prints them
// (PayPal hands back the same token while it is still valid, so a renewal may return the token we had.)
console.log('JUNCO call: 401 on the expired token, renewed, retried once -> 200');

const { server } = await createServer(ctx, { default: 'allow', tools: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: 'check-token', version: '0' });
await client.connect(b);
ctx.expire();
const text = ((await client.callTool({ name: 'list_disputes', arguments: {} })) as any).content[0].text as string;
assert.doesNotMatch(text, /"status":401/, 'toolkit call still saw the expired token');
assert.match(text, /dispute_id/);
console.log('toolkit list_disputes: 401 on the expired token, renewed, retried once -> disputes listed');
console.log('token: ok');
process.exit(0);
