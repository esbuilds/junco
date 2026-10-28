// Self-check probe, offline (a stand-in hosted connection, no PayPal): a tool list alone is not health; one real call
// decides. PayPal's Oct 29 failure (every call PAYPAL_API_SETUP_ERROR while tools/list was fine) must read as failing.
import assert from 'node:assert/strict';
import { hostedHealth } from './hosted.js';

const tools = Array.from({ length: 46 }, (_, i) => ({ name: i ? `tool_${i}` : 'list_products', inputSchema: { type: 'object', properties: { page_size: {} } } })) as any[];
const conn = (text: string, isError = false) => {
  const sent: any[] = [];
  return { sent, tools, client: { callTool: async (c: any) => (sent.push(c), { content: [{ type: 'text', text }], isError }) } as any };
};
const bad = conn('{"ok":false,"code":"PAYPAL_API_SETUP_ERROR","message":"Unsupported cache mode: default"}');
await assert.rejects(hostedHealth(bad), /^Error: 46 tools, calls failing: Unsupported cache mode: default$/);
assert.deepEqual(bad.sent, [{ name: 'list_products', arguments: { page_size: 1 } }]); // the smallest page, only args the schema has
await assert.rejects(hostedHealth(conn('upstream down', true)), /calls failing: upstream down/);
assert.equal(await hostedHealth(conn('{"products":[]}')), '46 tools, calls ok');
await assert.rejects(hostedHealth({ tools: [], client: {} as any }), /no list_products/);
console.log('hosted health: ok:false or an error result is "calls failing"; a list of tools alone never passes');
