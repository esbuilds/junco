// The desk-wide Claude cap (v3.14 item 3), offline: spend is metered from responses, a call past the cap fails at once
// with no network call, and a billing error pauses the AI for the day. Runs in a temp directory with a fake fetch.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.chdir(mkdtempSync(join(tmpdir(), 'junco-spend-')));
delete process.env.DATABASE_URL;
process.env.DESK_DAILY_USD = '1';
process.env.ANTHROPIC_API_KEY = 'test';
const { claude, claudeDown, isClaudeDown, readSpend } = await import('./spend.js');

let calls = 0, reply: () => Response;
globalThis.fetch = (async () => { calls++; return reply(); }) as any;
const ok = (input: number, output: number) => () => new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: input, output_tokens: output } }), { status: 200, headers: { 'content-type': 'application/json' } });
const ask = () => claude().messages.create({ model: 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] });
const settle = () => new Promise((r) => setTimeout(r, 50)); // metering reads the response body after it's returned

reply = ok(100_000, 10_000); // $0.40 + $0.20
await ask(); await settle();
assert.equal(readSpend().usd, 0.6); assert.equal(claudeDown(), null);
await ask(); await settle(); // now $1.20, past the $1 cap
assert.match(claudeDown()!, /\$1 daily AI budget/);
const before = calls;
await assert.rejects(ask(), (e: any) => isClaudeDown(e) && e.status === 400);
assert.equal(calls, before); // refused without a network call, and not retried
console.log('cap: metered from usage, past $1 the next call fails at once, no request sent');

process.env.DESK_DAILY_USD = '100';
// The assistant: one name, one tool, and a failed question shows in the self-check until one works.
const { studioAiTurn, assistantFailure } = await import('./studio-ai.js');
const res = { writeHead() {}, write() {}, end() {} } as any, dup = { input: [], tools: ['a', 'a', 'b'].map((name) => ({ name, parameters: {} })) };
let sent: any;
const fake = (fail?: string): any => ({ messages: { stream: (b: any) => { sent = b; if (fail) throw new Error(fail);
  return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => ({ content: [], usage: {}, model: 'm', stop_reason: 'end_turn' }) }; } } });
await studioAiTurn(dup, res, 'v', fake('400 Tool names must be unique'));
assert.deepEqual(sent.tools.map((t: any) => t.name), ['a', 'b']);
assert.equal(assistantFailure(), '400 Tool names must be unique');
await studioAiTurn(dup, res, 'v', fake());
assert.equal(assistantFailure(), null);
console.log('assistant: duplicate tool names dropped, a failed question reported until one works');

reply = () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }), { status: 400, headers: { 'content-type': 'application/json' } });
await assert.rejects(ask(), (e: any) => isClaudeDown(e)); await settle();
assert.match(claudeDown()!, /out of credit/);
console.log('billing error: the AI pauses for the day');
console.log('ok');
