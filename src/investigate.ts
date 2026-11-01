// A fresh Claude's turns over tools, shared by the fresh-agent CLI and the drill so both run one path: the model asks, each
// call goes to the caller's onCall (which decides what is refused and what is sent), and the loop ends on an answer or at
// the turn limit. What a read-only investigation may be offered is here too; anything else is never offered and, if the
// model calls it anyway, the caller refuses it before it leaves.
import type Anthropic from '@anthropic-ai/sdk';
import type { Policy } from './gate.js';

export const MODEL = 'claude-sonnet-5-5';
export const SYSTEM = 'You are investigating a record using the tools available. Answer only from what the tools return, and say plainly when something is not recorded.';

// The language of this desk. With little to go on a model can answer in anything: a blank customer message once got its whole reply in Chinese.
export const REPLY_LANGUAGE = 'Reply in English, the language of this desk, whatever language the input is in.';
// The support agent, for a customer (refund-ask.ts) or the owner (fresh-agent --propose): one prompt, so the two can't drift.
export const supportPrompt = (who: 'customer' | 'owner') => `You are the store's support agent. Use the tools to act on the ${who}'s request. ${REPLY_LANGUAGE}`;

export const isRead = (policy: Policy, name: string) => name.startsWith('junco_') || policy.tools[name] === 'read';
export const toolSpec = (t: { name: string; description?: string; inputSchema: any }) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema as Anthropic.Tool.InputSchema });

// answer: null when the turns ran out. usd at the repo's one rate (spend.ts).
// onText streams the model's own words as they come; without it the call waits for the whole reply.
export async function toolLoop(o: { client: Anthropic; system: string; tools: Anthropic.Tool[]; messages: Anthropic.MessageParam[]; maxTurns: number; maxTokens: number;
  onCall: (c: Anthropic.ToolUseBlock) => Promise<Anthropic.ToolResultBlockParam>; onText?: (t: string) => void }): Promise<{ answer: string | null; usd: number }> {
  let usd = 0;
  for (let turn = 0; turn < o.maxTurns; turn++) {
    const params = { model: MODEL, max_tokens: o.maxTokens, system: o.system, tools: o.tools, messages: o.messages };
    const res = o.onText ? await o.client.messages.stream(params).on('text', (t) => o.onText!(t)).finalMessage() : await o.client.messages.create(params);
    usd += ((res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0)) * 4 + (res.usage.cache_read_input_tokens ?? 0) * 0.4 + res.usage.output_tokens * 20) / 1e6;
    o.messages.push({ role: 'assistant', content: res.content });
    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!calls.length) return { answer: res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n'), usd };
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const c of calls) results.push(await o.onCall(c));
    o.messages.push({ role: 'user', content: results });
  }
  return { answer: null, usd };
}
