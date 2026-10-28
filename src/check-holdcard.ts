// S3 check: the hold card on the gated hosted server, without Claude. Tools the policy can hold carry the card; the
// resource is an MCP App; a held refund (stand-in payment, held before any PayPal call, then rejected) reports its status;
// and the card itself, in a headless browser acting as the host, shows the hold and then how it ended.
// Reads PayPal's tool list only; writes one check hold to the local .junco/holds.json, as check-gate does.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadPolicy } from './gate.js';
import { createHostedServer } from './hosted.js';
import { HOLD_CARD } from './holdcard.js';
import { sandboxCtx } from './server.js';

const ctx = await sandboxCtx();
const { server, holds } = await createHostedServer(ctx, loadPolicy());
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: 'check-holdcard', version: '0' });
await client.connect(b);
const tools = (await client.listTools()).tools;
const meta = (n: string) => (tools.find((t) => t.name === n)?._meta as any)?.ui;
assert.equal(meta('create_refund')?.resourceUri, HOLD_CARD); assert.equal(meta('accept_dispute_claim')?.resourceUri, HOLD_CARD);
assert.equal(meta('get_dispute'), undefined); // reads get no card
assert.deepEqual(meta('junco_hold_status')?.visibility, ['app']);
const desc = (n: string) => tools.find((t) => t.name === n)?.description ?? '';
for (const t of ['create_refund', 'accept_dispute_claim']) assert.match(desc(t), /^Through this server, this call does not run when you make it\. It creates a hold/, t);
assert.match(desc('make_dispute_offer'), /at most 25 .* it creates a hold/); assert.doesNotMatch(desc('get_dispute'), /Through this server/);
assert.match(client.getInstructions() ?? '', /owner approval gate/);
console.log('tools/list on /mcp/paypal: held and limited tools say what the gate does; reads untouched; instructions too');
const res = (await client.readResource({ uri: HOLD_CARD })).contents[0] as any;
assert.equal(res.mimeType, 'text/html;profile=mcp-app'); assert.match(res.text, /ui\/initialize/); assert.doesNotMatch(res.text, /Approve/);
console.log('tools/list: held tools carry the card, reads don\'t, the status tool is app-only; resource is text/html;profile=mcp-app with no approve button');

const held = await client.callTool({ name: 'create_refund', arguments: { capture_id: 'CHECKHOLDCARD0001', amount: { value: '1.00', currency_code: 'USD' } } }) as any;
const out = JSON.parse(held.content[0].text);
assert.equal(out.held, true);
const status = async () => JSON.parse(((await client.callTool({ name: 'junco_hold_status', arguments: { hold_id: out.hold_id } })) as any).content[0].text);
assert.equal((await status()).status, 'pending');

// The card in a browser; the parent page plays the host: answers ui/initialize, sends the tool result, relays tools/call.
const { chromium } = createRequire(new URL('../studio/package.json', import.meta.url))('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
if (process.env.DEBUG_CARD) page.on('console', (m: any) => console.log('[page]', m.text())), page.on('pageerror', (e: any) => console.log('[pageerror]', e.message));
await page.exposeFunction('statusOf', async () => JSON.stringify((await client.callTool({ name: 'junco_hold_status', arguments: { hold_id: out.hold_id } })) as any));
await page.setContent(`<iframe id="f" style="width:420px;height:400px;border:0"></iframe><script>
  const f = document.getElementById('f'); window.sizes = [];
  window.addEventListener('message', async (e) => { const m = e.data;
    if (m.method === 'ui/initialize') f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2026-01-26', hostCapabilities: {}, hostInfo: { name: 'check', version: '0' }, hostContext: {} } }, '*');
    if (m.method === 'ui/notifications/initialized') f.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: ${JSON.stringify(held)} }, '*');
    if (m.method === 'ui/notifications/size-changed') window.sizes.push(m.params.height);
    if (m.method === 'tools/call') f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: JSON.parse(await statusOf()) }, '*');
  });
  f.srcdoc = ${JSON.stringify(res.text).replace(/</g, '\\u003c')}; // escaped: the card's own closing script tag would end this one
</script>`);
const frame = () => page.frames()[1];
await page.waitForFunction(() => (document.getElementById('f') as any).contentDocument?.body?.innerText?.includes('Held for the owner'), null, { timeout: 15000 });
assert.match(await frame().innerText('body'), /Waiting for the owner/);
await holds.reject(out.hold_id);
await page.waitForFunction(() => (document.getElementById('f') as any).contentDocument?.body?.innerText?.includes('Rejected by the owner'), null, { timeout: 15000 });
assert.ok((await page.evaluate(() => (window as any).sizes.length)) > 0, 'the card reports its size');
console.log('card: rendered "Held for the owner", then "Rejected by the owner. Nothing was sent to PayPal." after the owner rejected it');
await browser.close();
console.log('holdcard: ok');
process.exit(0);
