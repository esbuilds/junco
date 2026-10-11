// The three cases a gate has to get right, through a real MCP server and client: allowed, held, and stale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { gate, jsonStore, type Decision } from '../src/index.js';

// A toy payments server: transfers move money; the account can be closed between hold and approval.
async function setup() {
  const ledger: number[] = [];
  let open = true;
  const server = new McpServer({ name: 'toy-payments', version: '1.0.0' });
  server.registerTool('transfer', { description: 'Send money', inputSchema: { amount: z.number() } }, async ({ amount }) => {
    ledger.push(amount);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, sent: amount }) }] };
  });
  const log: Decision[] = [];
  const holds = gate(server, { default: 'deny', tools: { transfer: { max_amount: 100, over: 'hold' } } }, {
    store: jsonStore(join(mkdtempSync(join(tmpdir(), 'gate-')), 'holds.json')),
    beforeRun: async () => ({ refuse: open ? null : 'the account was closed after this was held' }),
    log: (d) => log.push(d),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(b);
  const call = async (amount: number) => JSON.parse(((await client.callTool({ name: 'transfer', arguments: { amount } })) as any).content[0].text);
  return { ledger, holds, log, call, close: () => { open = false; } };
}

test('allowed: a call within the limit runs, and the decision is logged', async () => {
  const t = await setup();
  assert.deepEqual(await t.call(40), { ok: true, sent: 40 });
  assert.deepEqual(t.ledger, [40]);
  assert.equal(t.log[0].verdict, 'allow'); assert.equal(t.log[0].error, undefined);
});

test('held: a call over the limit waits; approval runs exactly that call, once', async () => {
  const t = await setup();
  const r = await t.call(500);
  assert.equal(r.held, true);
  assert.deepEqual(t.ledger, []);
  const h = await t.holds.approve(r.hold_id);
  assert.equal(h.status, 'completed');
  assert.deepEqual(t.ledger, [500]);
  await assert.rejects(t.holds.approve(r.hold_id), /already completed/);
  assert.deepEqual(t.ledger, [500]);
});

test('stale: if the world changed after the hold, approval refuses and nothing runs', async () => {
  const t = await setup();
  const r = await t.call(500);
  t.close();
  await assert.rejects(t.holds.approve(r.hold_id), /account was closed/);
  assert.equal(t.holds.holds()[0].status, 'stale');
  assert.deepEqual(t.ledger, []);
});

test('allowed but refused upstream: the log carries the error, so it never reads as done', async () => {
  const server = new McpServer({ name: 'refuser', version: '1.0.0' });
  server.registerTool('ping', { description: 'Always refused', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, status: 403, message: 'Forbidden' }) }] }));
  const log: Decision[] = [];
  gate(server, { default: 'deny', tools: { ping: 'allow' } }, { store: jsonStore(join(mkdtempSync(join(tmpdir(), 'gate-')), 'h.json')), log: (d) => log.push(d) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(b);
  await client.callTool({ name: 'ping', arguments: {} });
  assert.equal(log[0].verdict, 'allow');
  assert.match(log[0].error ?? '', /403/);
});
