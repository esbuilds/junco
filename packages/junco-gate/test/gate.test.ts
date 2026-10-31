// The three cases a gate has to get right, through a real MCP server and client: allowed, held, and stale. Then the daily total.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { gate, jsonStore, jsonTotal, type Decision, type GateOptions } from '../src/index.js';

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

// The PayPal hooks the CLI uses (--paypal): a held accept snapshots the case; if PayPal moves it on before the owner
// approves, approval re-reads it and refuses, and the accept never runs.
test('paypal hooks: a case that moved on is refused as stale', async () => {
  const { paypalDisputeHooks } = await import('../src/paypal.js');
  let accepted = 0;
  let dispute: any = { status: 'WAITING_FOR_SELLER_RESPONSE', dispute_life_cycle_stage: 'INQUIRY', dispute_amount: { value: '62.00', currency_code: 'USD' }, links: [{ rel: 'accept_claim' }] };
  const server = new McpServer({ name: 'toy-paypal', version: '1.0.0' });
  server.registerTool('accept_dispute_claim', { description: 'Refund in full', inputSchema: { dispute_id: z.string() } }, async () => {
    accepted++; return { content: [{ type: 'text', text: '{"ok":true}' }] };
  });
  const g = gate(server, { default: 'deny', tools: { accept_dispute_claim: 'hold' } }, {
    store: jsonStore(join(mkdtempSync(join(tmpdir(), 'gate-')), 'holds.json')), ...paypalDisputeHooks(async () => dispute),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(b);
  const r: any = await client.callTool({ name: 'accept_dispute_claim', arguments: { dispute_id: 'PP-R-X' } });
  const { hold_id } = JSON.parse(r.content[0].text);
  dispute = { ...dispute, dispute_life_cycle_stage: 'CHARGEBACK', status: 'UNDER_REVIEW' };
  await assert.rejects(g.approve(hold_id), /moved from INQUIRY to CHARGEBACK/);
  assert.equal(accepted, 0);
  assert.equal(g.holds()[0].status, 'stale');
});

test('duplicate: the same call asked twice joins the waiting hold; after it ran, a repeat is refused', async () => {
  const t = await setup();
  const r = await t.call(500), again = await t.call(500);
  assert.equal(again.hold_id, r.hold_id); assert.equal(again.duplicate, true);
  assert.equal(t.holds.holds().length, 1);
  await t.holds.approve(r.hold_id);
  assert.equal((await t.call(500)).error.type, 'duplicate_call');
  assert.deepEqual(t.ledger, [500]);
});

test('tools/list: a client reads what the gate does before calling; reads are untouched', async () => {
  const server = new McpServer({ name: 'toy', version: '1.0.0' });
  const reg = (n: string) => server.registerTool(n, { description: `Original ${n}`, inputSchema: { amount: z.number() } }, async () => ({ content: [{ type: 'text', text: '{}' }] }));
  ['refund', 'transfer', 'cap', 'balance'].forEach(reg);
  gate(server, { default: 'deny', tools: { refund: 'hold', transfer: { max_amount: 100, over: 'hold' }, cap: { max_amount: 5, over: 'deny' }, balance: 'read' } },
    { store: jsonStore(join(mkdtempSync(join(tmpdir(), 'gate-')), 'holds.json')) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(b);
  const d = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.description]));
  assert.match(d.refund!, /^Through this server, this call does not run when you make it\. It creates a hold.*at most once\. Calling this tool is how you propose the action to the owner\.\n\nOriginal refund$/s);
  assert.match(d.transfer!, /^Through this server, a call with an amount of at most 100 .* runs directly; above that, or with no readable amount, it creates a hold.*\n\nOriginal transfer$/s);
  assert.match(d.cap!, /at most 5 .*it is refused\.\n\nOriginal cap$/s);
  assert.equal(d.balance, 'Original balance');
  assert.doesNotMatch(d.refund!, /standing approval/); // no allow hook, no exception claimed
  assert.match(client.getInstructions() ?? '', /owner approval gate/);
});

// The daily total. The tool waits before it answers, so a reservation made after the first await would let every concurrent call through.
async function totalled(o: { max?: number; dir?: string; rule?: any; gate?: Partial<GateOptions>; rules?: Record<string, any>; answer?: () => any } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'gate-total-')), ran: any[] = [];
  const server = new McpServer({ name: 'bank', version: '1.0.0' });
  const answer = o.answer ?? (() => ({ ok: true }));
  for (const name of ['transfer', 'accept', 'note', 'peek'])
    server.registerTool(name, { description: name, inputSchema: { amount: z.any().optional(), memo: z.string().optional(), id: z.string().optional() } }, async (a: any) => {
      await new Promise((r) => setTimeout(r, 5));
      ran.push(a); const out = answer();
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    });
  const policy: any = { default: 'deny', tools: { transfer: o.rule ?? { max_amount: 25, over: 'hold' }, accept: 'hold', note: 'allow', peek: 'read', ...o.rules }, ...(o.max !== undefined && { daily_total: { max: o.max, over: 'hold' } }) };
  const totalFile = join(dir, 'total.json');
  const g = gate(server, policy, { store: jsonStore(join(dir, 'holds.json')), totals: jsonTotal(totalFile), ...o.gate });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(b);
  const call = async (name: string, args: any) => { const r: any = await client.callTool({ name, arguments: args }); return r.isError ? { thrown: r.content[0].text } : JSON.parse(r.content[0].text); };
  const total = () => jsonTotal(totalFile).read();
  return { dir, ran, g, call, total, totalFile, client };
}
const pay = (amount: unknown, memo = 'a') => ({ amount, memo });

test('daily total: concurrent calls cannot both pass the last dollars', async () => {
  const t = await totalled({ max: 100 });
  const out = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => t.call('transfer', pay(25, `m${n}`))));
  assert.equal(out.filter((r) => r.ok).length, 4); assert.equal(out.filter((r) => r.held).length, 2);
  assert.equal(t.ran.length, 4); assert.deepEqual([t.total()!.cents, t.total()!.calls], [10000, 4]);
  // Cents, not floats: 0.1 + 0.2 lands on the line, and one cent more does not.
  const c = await totalled({ max: 0.3 });
  assert.ok((await c.call('transfer', pay(0.1, 'x'))).ok); assert.ok((await c.call('transfer', pay(0.2, 'y'))).ok);
  assert.ok((await c.call('transfer', pay(0.01, 'z'))).held);
});

test('daily total: over it holds, never denies, and an approved hold does not count', async () => {
  const t = await totalled({ max: 30 });
  assert.ok((await t.call('transfer', pay(25))).ok);
  const r = await t.call('transfer', pay(25, 'b'));
  assert.equal(r.held, true); assert.match(r.reason, /daily total was reached: 25\.00 of 30 USD approved in advance today \(UTC\), and this 25\.00 would pass it/);
  assert.doesNotMatch(r.reason, /money out/i);
  assert.equal(t.ran.length, 1); assert.equal(t.g.holds()[0].status, 'pending');
  assert.equal((await t.g.approve(r.hold_id)).status, 'completed');
  assert.equal(t.ran.length, 2); assert.equal(t.total()!.cents, 2500, 'the owner is the authority: approved holds do not count');
  assert.ok((await t.call('transfer', pay(5, 'c'))).ok, 'and what is left is still left');
});

test('daily total: a restart keeps it', async () => {
  const t = await totalled({ max: 40 });
  await t.call('transfer', pay(25));
  const again = await totalled({ max: 40, dir: t.dir });
  assert.ok((await again.call('transfer', pay(25, 'b'))).held);
  assert.ok((await again.call('transfer', pay(15, 'c'))).ok);
  assert.equal(again.total()!.cents, 4000);
});

test('daily total: a definite refusal releases; a throw or an unknown outcome keeps', async () => {
  let answer: () => any = () => ({ error: { type: 'bad', message: 'PayPal 422' } });
  const t = await totalled({ max: 100, answer: () => answer(), gate: { unknownErrors: ['upstream_unavailable'] } });
  await t.call('transfer', pay(25));
  assert.deepEqual([t.total()!.cents, t.total()!.calls], [0, 0], 'refused: released');
  answer = () => ({ error: { type: 'upstream_unavailable', message: 'no answer' } });
  await t.call('transfer', pay(25, 'b'));
  assert.equal(t.total()!.cents, 2500, 'unknown outcome: kept');
  answer = () => { throw new Error('socket hang up'); };
  assert.ok((await t.call('transfer', pay(25, 'c'))).thrown);
  assert.equal(t.total()!.cents, 5000, 'thrown: kept');
  // With a refused() hook, only what it calls definite releases.
  const strict = await totalled({ max: 100, answer: () => ({ error: { message: 'PayPal 500' } }), gate: { refused: (x) => /PayPal 4/.test(x ?? '') } });
  await strict.call('transfer', pay(25));
  assert.equal(strict.total()!.cents, 2500, 'not definite: kept');
});

test('daily total: the UTC day rolls over, and a refusal after midnight leaves the new day alone', async (c) => {
  c.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T23:59:59.000Z') });
  let at: (() => void) | null = null, answer: () => any = () => ({ ok: true });
  const t = await totalled({ max: 30, answer: () => { at?.(); return answer(); } });
  assert.ok((await t.call('transfer', pay(25))).ok);
  assert.ok((await t.call('transfer', pay(25, 'b'))).held);
  c.mock.timers.setTime(Date.parse('2026-10-31T00:00:00.000Z'));
  assert.ok((await t.call('transfer', pay(25, 'c'))).ok);
  assert.deepEqual([t.total()!.day, t.total()!.cents], ['2026-10-31', 2500]);
  c.mock.timers.setTime(Date.parse('2026-10-31T23:59:59.000Z'));
  answer = () => ({ error: { message: 'PayPal 422' } }); at = () => c.mock.timers.setTime(Date.parse('2026-11-01T00:00:01.000Z'));
  await t.call('transfer', pay(1, 'd'));
  assert.equal(t.total()!.day, '2026-10-31', 'the release sees a new day and writes nothing');
});

test('daily total: a standing approval counts, a plain money tool only through money(), and reads never', async () => {
  const dispute: Record<string, number> = { D1: 62, D2: 62 };
  const t = await totalled({ max: 100, gate: { allow: (m, a) => (m === 'accept' && dispute[a.id] ? 'standing approval' : null), money: (m, a) => (m === 'accept' ? { value: dispute[a.id] ?? null, currency: 'USD' } : undefined) } });
  assert.ok((await t.call('accept', { id: 'D1' })).ok); assert.equal(t.total()!.cents, 6200, 'an accept counts at the disputed amount');
  const over = await t.call('accept', { id: 'D2' });
  assert.ok(over.held); assert.match(over.reason, /daily total was reached/);
  await t.call('note', { memo: 'x' }); await t.call('peek', { amount: 5000 });
  assert.equal(t.total()!.calls, 1, 'a message and a read count for nothing');
  const plain = await totalled({ max: 10, rules: { note: 'allow' }, gate: { money: (m, a) => (m === 'note' ? { value: a.amount ?? null } : undefined) } });
  assert.ok((await plain.call('note', { amount: 8 })).ok); assert.ok((await plain.call('note', { amount: 8, memo: 'b' })).held);
  assert.ok((await plain.call('note', { memo: 'c' })).held, 'a money call with no readable amount holds');
});

test('daily total: an unreadable or non-USD amount holds', async () => {
  const t = await totalled({ max: 100, rule: { max_amount: 1000, over: 'hold' } });
  const eur = await t.call('transfer', { amount: { value: '5.00', currency_code: 'EUR' } });
  assert.ok(eur.held); assert.match(eur.reason, /in USD and this call is in EUR/);
  assert.ok((await t.call('transfer', { amount: { value: '5.00', currency_code: 'USD' } })).ok);
  assert.ok((await t.call('transfer', { amount: { value: '-5.00', currency_code: 'USD' }, memo: 'neg' })).held);
  assert.equal(t.total()!.cents, 500);
});

test('daily total: clients are told, and with none set the gate behaves exactly as before', async () => {
  const on = await totalled({ max: 100 }), off = await totalled();
  const list = async (x: typeof on) => Object.fromEntries((await x.client.listTools()).tools.map((l) => [l.name, l.description]));
  const a = await list(on), b = await list(off);
  assert.match(a.transfer!, /daily total: calls approved in advance, offers included, may add up to 100 USD a UTC day/);
  assert.equal(a.transfer!.replace(/ The owner also set a daily total.*?doesn't count toward it\./s, ''), b.transfer);
  assert.doesNotMatch(b.transfer!, /daily total/); assert.doesNotMatch(a.note!, /daily total/);
  assert.match(on.client.getInstructions() ?? '', /100 USD a UTC day/); assert.doesNotMatch(off.client.getInstructions() ?? '', /daily total|UTC day/);
  for (let n = 0; n < 8; n++) assert.ok((await off.call('transfer', pay(25, `m${n}`))).ok);
  assert.equal(off.ran.length, 8); assert.equal(existsSync(off.totalFile), false, 'no total file is ever written');
  assert.ok((await off.call('transfer', pay(26))).held, 'the per-call limit still applies');
});
