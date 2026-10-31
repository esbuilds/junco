// AG Studio's AI assistant, server half: Studio's adapter posts one turn (conversation, instructions, tool schemas) and
// this streams Claude's answer back as AG Studio events, one JSON object per line. The Anthropic key stays here.
// Studio's tools run in the browser and only arrange the dashboard; nothing here can move money, submit evidence or reach the gate.
import { claude, claudeDown, isClaudeDown, pausedText } from './spend.js';
import Anthropic from '@anthropic-ai/sdk';
import type { ServerResponse } from 'node:http';

export const STUDIO_AI = process.env.STUDIO_AI === '1';
const MODEL = process.env.STUDIO_AI_MODEL ?? 'claude-sonnet-5-5'; // Studio's agents call the model 5 to 16 times per question
const QUESTIONS_PER_VISITOR = 10; // a question is a new run of Studio's lead agent; its hand-offs to the data, page and widget agents are not
const CALLS_PER_VISITOR = 300; // ponytail: backstop for long tool loops; per process, resets on restart and at midnight UTC
const LIMIT = "That's the limit for this session. The rest of the desk still works as normal.";

let day = '';
const used = new Map<string, { runs: Set<string>; calls: number }>();

// The plain message a judge sees past the cap, or null when the turn may run.
export function allowTurn(visitor: string, trace: any): string | null {
  const today = new Date().toISOString().slice(0, 10);
  if (day !== today) { day = today; used.clear(); }
  const u = used.get(visitor) ?? { runs: new Set<string>(), calls: 0 };
  used.set(visitor, u);
  const question = trace?.agentId === 'lead' && !u.runs.has(trace.runId);
  if ((question && u.runs.size >= QUESTIONS_PER_VISITOR) || u.calls >= CALLS_PER_VISITOR) return LIMIT;
  if (question) u.runs.add(trace.runId);
  u.calls++;
  return null;
}

// For the self-check: why the latest real question failed, cleared by the next one that works. Passive on purpose: the tool
// list comes from the browser, and a real question costs about $0.17, so a probe every 30 minutes can't stand in for it.
// ponytail: it hears nothing until someone asks; a paused AI is reported by the Claude check instead.
let lastFailure: string | null = null;
export const assistantFailure = () => lastFailure;

const text = (c: any[]) => (c ?? []).map((p) => p.text ?? p.refusal ?? '').join('');

// Studio's conversation items (Responses-style) to Anthropic messages. Reasoning items are dropped; thinking stays off.
export function toMessages(input: any[]) {
  const system: string[] = [];
  const out: { role: 'user' | 'assistant'; content: any[] }[] = [];
  const push = (role: 'user' | 'assistant', block: any) => {
    const prev = out.at(-1);
    if (prev?.role === role) prev.content.push(block); else out.push({ role, content: [block] });
  };
  for (const it of input) {
    if (it.type === 'message' && it.role === 'system') system.push(text(it.content));
    else if (it.type === 'message' && it.role === 'user') push('user', { type: 'text', text: text(it.content) || '(empty)' });
    else if (it.type === 'message' && it.role === 'assistant') { const t = text(it.content); if (t) push('assistant', { type: 'text', text: t }); }
    else if (it.type === 'function_call') push('assistant', { type: 'tool_use', id: it.callId, name: it.name, input: safeJson(it.arguments) });
    else if (it.type === 'function_call_output') push('user', { type: 'tool_result', tool_use_id: it.callId, content: String(it.output ?? '') });
  }
  return { system, messages: out };
}

const safeJson = (s: string) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

// Current Sonnet and Opus reject forced tool_choice (any / tool), so a forced call becomes auto plus an instruction.
function toolChoice(c: any): { choice: { type: 'auto' | 'none' }; note?: string } {
  if (c === 'none') return { choice: { type: 'none' } };
  if (c === 'required') return { choice: { type: 'auto' }, note: 'Call one of your tools in this reply.' };
  if (c?.name) return { choice: { type: 'auto' }, note: `Call the ${c.name} tool in this reply.` };
  return { choice: { type: 'auto' } };
}

export async function studioAiTurn(body: any, res: ServerResponse, visitor: string, client = claude()) {
  const send = (o: unknown) => res.write(JSON.stringify(o) + '\n');
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  const id = `turn_${Date.now().toString(36)}`;
  const limited = claudeDown() ? pausedText() : allowTurn(visitor, body?.trace); // v3.14: a paused AI answers in words, not an error
  if (limited) {
    const mid = `${id}_limit`;
    send({ type: 'TEXT_MESSAGE_START', messageId: mid, role: 'assistant' });
    send({ type: 'TEXT_MESSAGE_CONTENT', messageId: mid, delta: limited });
    send({ type: 'TEXT_MESSAGE_END', messageId: mid });
    send({ done: { id, createdAt: Date.now(), status: 'completed', output: [{ id: mid, kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text: limited, annotations: [] }] }] } });
    return res.end();
  }
  const { system, messages } = toMessages(body?.input ?? []);
  // Current models take no assistant prefill; a turn Studio sends ending on the assistant gets a nudge to carry on.
  if (messages.at(-1)?.role === 'assistant') messages.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
  if (body?.instructions) system.unshift(body.instructions);
  const forced = toolChoice(body?.toolChoice);
  if (forced.note) system.push(forced.note);
  if (body?.responseFormat?.type === 'json') system.push(`Reply with only a JSON object matching this schema, no prose:\n${JSON.stringify(body.responseFormat.schema)}`);
  // Claude refuses a turn with two tools of one name (Oct 30: every question failed), so one name, one tool.
  const tools: any[] = [...new Map((body?.tools ?? []).filter((t: any) => !t.kind || t.kind === 'client')
    .map((t: any) => [t.name, { name: t.name, description: t.description, input_schema: t.parameters }])).values()];
  // Studio resends the same instructions and tool schemas every round, so cache them and the conversation so far.
  const cache = { cache_control: { type: 'ephemeral' } };
  if (tools.length) Object.assign(tools[tools.length - 1], cache);
  const lastBlock = messages.at(-1)?.content.at(-1);
  if (lastBlock) Object.assign(lastBlock, cache);
  const output: any[] = [];
  try {
    const stream = client.messages.stream({
      model: MODEL, max_tokens: 16000, system: [{ type: 'text', text: system.join('\n\n') || ' ', ...cache }],
      messages: messages.length ? messages : [{ role: 'user', content: '(empty)' }],
      ...(tools.length ? { tools, tool_choice: forced.choice } : {}),
    } as any);
    const blocks = new Map<number, string>(); // content index -> message or tool call id
    for await (const ev of stream as AsyncIterable<any>) {
      if (ev.type === 'content_block_start') {
        const b = ev.content_block;
        if (b.type === 'text') { const mid = `${id}_${ev.index}`; blocks.set(ev.index, mid); send({ type: 'TEXT_MESSAGE_START', messageId: mid, role: 'assistant' }); }
        if (b.type === 'tool_use') { blocks.set(ev.index, b.id); send({ type: 'TOOL_CALL_START', toolCallId: b.id, toolCallName: b.name }); }
      } else if (ev.type === 'content_block_delta') {
        const ref = blocks.get(ev.index);
        if (ev.delta.type === 'text_delta') send({ type: 'TEXT_MESSAGE_CONTENT', messageId: ref, delta: ev.delta.text });
        if (ev.delta.type === 'input_json_delta' && ev.delta.partial_json) send({ type: 'TOOL_CALL_ARGS', toolCallId: ref, delta: ev.delta.partial_json });
      } else if (ev.type === 'content_block_stop') {
        const ref = blocks.get(ev.index);
        if (ref?.startsWith(id)) send({ type: 'TEXT_MESSAGE_END', messageId: ref });
        else if (ref) send({ type: 'TOOL_CALL_END', toolCallId: ref });
      }
    }
    const msg = await stream.finalMessage();
    lastFailure = null;
    msg.content.forEach((b: any, i: number) => {
      if (b.type === 'text') output.push({ id: `${id}_${i}`, kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text: b.text, annotations: [] }] });
      if (b.type === 'tool_use') output.push({ id: b.id, kind: 'output', type: 'function_call', callId: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}), status: 'completed' });
    });
    send({ done: {
      id, createdAt: Date.now(), output, model: msg.model,
      status: msg.stop_reason === 'max_tokens' ? 'incomplete' : 'completed',
      ...(msg.stop_reason === 'max_tokens' ? { incompleteDetails: { reason: 'max_output_tokens' } } : {}),
      usage: { // Studio counts cached tokens inside inputTokens; Anthropic reports them separately
        inputTokens: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
        outputTokens: msg.usage.output_tokens,
        cachedInputTokens: msg.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      },
    } });
  } catch (e: any) {
    console.error('[studio-ai]', e.message);
    if (!isClaudeDown(e)) lastFailure = String(e.message);
    send({ done: { id, createdAt: Date.now(), output, status: 'failed', error: { code: 'provider_error', message: isClaudeDown(e) ? pausedText() : 'The assistant could not answer just now. Try again in a moment.' } } });
  }
  res.end();
}
