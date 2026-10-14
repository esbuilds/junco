// Desk-wide Claude spend (STRATEGY v3.14 item 3). Every Claude call on the desk goes through claude(), whose fetch meters
// the day's spend from each response's usage and refuses new calls past DESK_DAILY_USD or after a billing error. A refused
// call fails at once as a plain 400 (the SDK doesn't retry it), so the desk turns read-only instead of erroring: cases,
// cached recommendations, holds, run pages and the pinned run all read from the desk's own files, not from Claude.
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mirror } from './persist.js';

const CAP = () => Number(process.env.DESK_DAILY_USD ?? 15);
const FILE = '.junco/spend.json';
export type Spend = { day: string; usd: number; calls: number; stopped?: string };
const today = () => new Date().toISOString().slice(0, 10);
export const readSpend = (): Spend => {
  try { const s = JSON.parse(readFileSync(FILE, 'utf8')); if (s.day === today()) return s; } catch {}
  return { day: today(), usd: 0, calls: 0 };
};
const save = (s: Spend) => { mkdirSync('.junco', { recursive: true }); writeFileSync(FILE, JSON.stringify(s, null, 2)); mirror(FILE, s); };

// Why Claude is paused today, or null. Resets at midnight UTC.
export function claudeDown(): string | null {
  const s = readSpend();
  return s.stopped ?? (s.usd >= CAP() ? `the desk's $${CAP()} daily AI budget is used up` : null);
}
const PAUSED = 'claude_paused';
export const isClaudeDown = (e: any) => String(e?.message ?? '').includes(PAUSED) || e?.status === 402 || /credit balance|billing|spend limit/i.test(String(e?.message ?? ''));
export const pausedText = () => `The AI is paused (${claudeDown() ?? 'the AI service is unavailable'}). The desk is read-only until it's back: cases, saved recommendations, holds and past runs all still work.`;

// ponytail: every model priced at the repo's Opus 5.5 rate ($4 in, $20 out per million, as on the eval card), which
// over-counts the Sonnet assistant; fine for a cap. Streams are metered from the first input and last output count.
const usdOf = (t: string) => {
  const n = (k: string) => [...t.matchAll(new RegExp(`"${k}":(\\d+)`, 'g'))].map((m) => Number(m[1]));
  const input = (n('input_tokens')[0] ?? 0) + (n('cache_creation_input_tokens')[0] ?? 0), read = n('cache_read_input_tokens')[0] ?? 0, out = n('output_tokens').at(-1) ?? 0;
  return (input * 4 + read * 0.4 + out * 20) / 1e6;
};
const add = (usd: number, stopped?: string) => { const s = readSpend(); save({ ...s, usd: Number((s.usd + usd).toFixed(4)), calls: s.calls + (usd ? 1 : 0), ...(stopped && { stopped }) }); };

async function metered(url: any, init?: any): Promise<Response> {
  const why = claudeDown();
  if (why) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `${PAUSED}: ${why}` } }), { status: 400, headers: { 'content-type': 'application/json' } });
  const res = await fetch(url, init);
  res.clone().text().then((t) => {
    if (!res.ok && (res.status === 402 || /credit balance|billing|spend limit/i.test(t))) add(0, `the AI account is out of credit (${new Date().toISOString().slice(11, 16)} UTC)`);
    else if (res.ok && /count_tokens/.test(String(url)) === false) add(usdOf(t));
  }).catch(() => {});
  return res;
}
export const claude = () => new Anthropic({ fetch: metered as any });
