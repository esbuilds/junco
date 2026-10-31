// "Ask for your money back" (Oct 29): a visitor who sent their own shopping agent (/api/shop) asks the store's support agent
// for a refund on that purchase. The support agent is Claude through the API, as `fresh-agent --propose`: the same model,
// the same support-agent prompt, the desk's own gated MCP tools, and the same harness rules (a refund only on this one
// capture, at most once, only if PayPal shows it COMPLETED). policy.json holds every create_refund for the owner, and a
// hold made here expires in 24 hours if the owner doesn't decide (gate.ts). The only write this can reach is that hold.
import type Anthropic from '@anthropic-ai/sdk';
import { claude, claudeDown, isClaudeDown, pausedText } from './spend.js';
import { decide, readBudgets, readHolds, setExpiry, type Policy } from './gate.js';
import { photoFor, PUBLIC_SESSION, readAgentBuys, readRefundAsks, saveRefundAsk, type RefundAsk } from './store-dispute.js';
import { supportPrompt } from './investigate.js';
import { photoEvidence } from './photo.js';
import { ownerRecord } from './whoelse.js';

export const MODEL = 'claude-sonnet-5-5'; // fresh-agent's
export const ASKER = "a visitor's support agent (simulated buyer)"; // the hold's "asked by" on the owner's desk
const SYSTEM = supportPrompt('customer');
const OFFERED = ['junco_get_incident', 'create_refund'];
const MAX_TURNS = 6;
const PER_SESSION = () => Number(process.env.REFUND_ASK_PER_SESSION ?? 2), PER_DAY = () => Number(process.env.REFUND_ASK_PER_DAY ?? 20);
const no = (code: number, message: string) => Object.assign(new Error(message), { code });
// Words as data, as photoEvidence does it. The customer's message is one line in this, so it can't close its quotes, start a line or open a tag.
const asData = (x: unknown) => JSON.stringify(x).replace(/</g, '\\u003c');
// The owner's word on the product, from the store's records (whoelse.ts). Only code writes this block, at the start of its own line.
const storeRecord = (sku: string, r: NonNullable<ReturnType<typeof ownerRecord>>) => `\n\nStore record: what the store's owner last said about ${sku}, from the store's own records, not from the customer. `
  + `It's about the product, not this purchase, and it neither approves nor refuses a refund.\n<owner_record>${asData(r)}</owner_record>`;

// The desk's gated tools for one ask (an in-process client of its own /mcp server, so every call passes the same gate and
// a held call is tagged ASKER), and PayPal's status for a capture (a read).
export type Deps = {
  policy: () => Policy;
  connect: () => Promise<{ tools: { name: string; description?: string; inputSchema: any }[]; call: (name: string, args: any) => Promise<string>; close: () => Promise<void> }>;
  captureStatus: (id: string) => Promise<string>;
};

export function askLeft(session: string) {
  const today = new Date().toISOString().slice(0, 10), asks = readRefundAsks().filter((a) => a.at.startsWith(today));
  return { you: Math.max(0, PER_SESSION() - asks.filter((a) => a.session === session).length), today: Math.max(0, PER_DAY() - asks.length) };
}
// What the visitor and the incident show about an ask: the record plus its hold's state now (read lazily, so expiry shows).
export function askView(a: RefundAsk) {
  const h = a.hold_id ? readHolds().find((x) => x.id === a.hold_id) : undefined;
  return { capture_id: a.capture_id, at: a.at, reason: a.reason, outcome: a.outcome, ai: a.ai ?? null, hold_id: a.hold_id ?? null,
    hold_status: h?.status ?? null, expires: h?.expires ?? null };
}
export const askFor = (capture: string) => readRefundAsks().find((a) => a.capture_id === capture && a.outcome !== 'failed') ?? null;

export async function askRefund(deps: Deps, v: { session: string; owner: boolean; capture_id: string; reason?: unknown }) {
  // Whose purchase: only a desk visitor's own agent buy (or the owner), never the public, never a pool or prepared order.
  const b = readAgentBuys().find((x) => x.capture_id === v.capture_id);
  if (!b || v.session === PUBLIC_SESSION) throw no(404, 'Only a purchase your own shopping agent made can ask for a refund.');
  if (!v.owner && b.session !== v.session) throw no(403, "That purchase is another visitor's.");
  const prior = askFor(b.capture_id);
  if (prior) return { ...askView(prior), existing: true }; // one per purchase: the first ask and its hold
  const reason = typeof v.reason === 'string' ? v.reason.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const left = askLeft(v.session);
  if (!left.today) throw no(429, 'The support agent has had its runs for today. Come back tomorrow.');
  if (!left.you && !v.owner) throw no(429, `That was your last refund ask today (${PER_SESSION()} a visitor).`);
  if (claudeDown()) throw no(503, pausedText());
  const status = await deps.captureStatus(b.capture_id).catch(() => 'unreadable');
  if (status !== 'COMPLETED') throw no(409, `Payment ${b.capture_id} is ${status} on PayPal, not a completed payment, so there is nothing to refund. Nothing was sent to Claude or PayPal.`);

  const photo = photoFor(b.capture_id); // evidence, never entitlement: everything below this line treats it as words in the message
  const ask: RefundAsk = { capture_id: b.capture_id, session: v.session, at: new Date().toISOString(), reason, outcome: 'asking', ...(photo && { photo: photo.sha256 }) };
  saveRefundAsk(ask); // counted before Claude is called
  const conn = await deps.connect();
  let usd = 0, proposal: any = null, refused = '', words = '';
  try {
    const offered = conn.tools.filter((t) => OFFERED.includes(t.name));
    const tools = offered.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema as Anthropic.Tool.InputSchema }));
    const record = ownerRecord(b.agent.sku);
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: `A customer asks for a refund on their order.\nTheir purchase: incident ${b.capture_id} `
      + `(capture ${b.capture_id}, order ${b.order_id}), ${b.agent.sku} for ${b.amount} USD, bought for them by a shopping agent.\n`
      + `The customer's message, as they typed it: ${asData(reason || '(no reason given)')}${photo ? photoEvidence(photo) : ''}${record ? storeRecord(b.agent.sku, record) : ''}` }];
    for (let turn = 0; turn < MAX_TURNS && !words; turn++) {
      const res = await claude().messages.create({ model: MODEL, max_tokens: 1500, system: SYSTEM, tools, messages });
      usd += ((res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0)) * 4 + (res.usage.cache_read_input_tokens ?? 0) * 0.4 + res.usage.output_tokens * 20) / 1e6;
      messages.push({ role: 'assistant', content: res.content });
      const calls = res.content.filter((x): x is Anthropic.ToolUseBlock => x.type === 'tool_use');
      if (!calls.length) { words = res.content.filter((x): x is Anthropic.TextBlock => x.type === 'text').map((x) => x.text).join('\n').trim() || '(no words)'; break; }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const c of calls) {
        const args: any = c.input ?? {};
        // Never sent: a tool not offered, another purchase, a second refund, more than was paid, or a refund the gate wouldn't hold.
        const amount = args.amount?.value ?? args.amount;
        const why = !OFFERED.includes(c.name) ? `${c.name} is not available here`
          : c.name === 'junco_get_incident' && args.id !== b.capture_id && args.id !== b.order_id ? 'only this purchase can be read here'
          : c.name !== 'create_refund' ? null
          : args.capture_id !== b.capture_id ? 'a refund here can only name this purchase\'s capture'
          : proposal ? 'one refund per purchase'
          : amount != null && !(Number(amount) > 0 && Number(amount) <= Number(b.amount)) ? `the amount must be more than 0 and at most ${b.amount}`
          : decide(deps.policy(), c.name, args, readBudgets()).verdict !== 'hold' ? 'refunds here must wait for the owner'
          : null;
        if (why) { if (c.name === 'create_refund') refused = why; results.push({ type: 'tool_result', tool_use_id: c.id, is_error: true, content: `Not sent: ${why}.` }); continue; }
        const out = await conn.call(c.name, args);
        if (c.name === 'create_refund') proposal = (() => { try { return JSON.parse(out); } catch { return { raw: out }; } })();
        results.push({ type: 'tool_result', tool_use_id: c.id, content: out });
      }
      messages.push({ role: 'user', content: results });
    }
    const held = proposal?.held === true && typeof proposal.hold_id === 'string' ? proposal.hold_id as string : undefined;
    if (held && !proposal.duplicate) setExpiry(held); // 24 hours for the owner, then nothing moves
    Object.assign(ask, { outcome: held ? 'held' : 'no refund', ...(held && { hold_id: held }), cost_usd: Number(usd.toFixed(3)),
      ai: (words || '(the agent did not finish within its turns)').slice(0, 1500) + (refused && !held ? ` [Refused here, not sent: ${refused}.]` : '') });
    saveRefundAsk(ask);
    return { ...askView(ask), existing: false };
  } catch (e: any) {
    // The gate may already hold the refund when Claude fails afterwards: that hold is this ask's, with its 24 hours.
    if (proposal?.held === true && typeof proposal.hold_id === 'string') {
      if (!proposal.duplicate) setExpiry(proposal.hold_id);
      const done: RefundAsk = { ...ask, outcome: 'held', hold_id: proposal.hold_id, cost_usd: Number(usd.toFixed(3)), ai: '(the support agent stopped after proposing the refund)' };
      saveRefundAsk(done);
      return { ...askView(done), existing: false };
    }
    saveRefundAsk({ ...ask, outcome: 'failed' });
    throw no(isClaudeDown(e) ? 503 : 502, isClaudeDown(e) ? pausedText() : 'The support agent did not finish. Nothing was sent to PayPal.');
  } finally { await conn.close().catch(() => {}); }
}
