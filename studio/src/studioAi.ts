// AG Studio's AI assistant, browser half. Studio runs its own agents and dashboard tools here; each model turn goes to
// the desk (/api/studio-ai), which calls Claude and streams Studio's events back. No API key in the browser.
import { AgStudioAiModule, AgStudioModuleRegistry, createAiHarness, directLlmRunner, type AgAiEvent, type AgAiTool, type AgBuiltInAgentId, type AgLlmAdapter, type AgLlmResponse } from 'ag-studio';
import { api as desk, money, TRIGGER, type Activity, type CaseDetail, type Hold } from './api';
import { selectCase } from './store';

export const QUESTION = 'Which disputes am I about to lose this week?';
const DID = 'What did JUNCO do without me this week?';
const TRACKING = 'Which orders have no tracking?';
// The starter button shows the question and sends it with the ask for a widget, so the answer lands on the Desk.
const PROMPT = `${QUESTION} Count every open dispute JUNCO says to Accept, whatever its deadline (the At risk panel's rule). Add one bar chart to this page showing the amount for each of them by dispute, then tell me in two sentences.`;

// Running token count for this tab, read by the reliability check (npm run check-studio-ai).
const usage = { calls: 0, input: 0, cached: 0, cacheWrite: 0, output: 0 };
(window as any).__studioUsage = usage;
function tally(r: AgLlmResponse) {
  usage.calls++;
  usage.input += r.usage?.inputTokens ?? 0; usage.cached += r.usage?.cachedInputTokens ?? 0;
  usage.cacheWrite += r.usage?.cacheWriteTokens ?? 0; usage.output += r.usage?.outputTokens ?? 0;
}

const adapter: AgLlmAdapter = {
  executeTurn(request, options) {
    const queue: AgAiEvent[] = [];
    let wake = null as (() => void) | null, ended = false;
    let finish!: (r: AgLlmResponse) => void;
    const complete = new Promise<AgLlmResponse>((r) => (finish = r));
    const failed = (message: string): AgLlmResponse => ({ id: 'failed', createdAt: Date.now(), output: [], status: 'failed', error: { code: 'network', message } });
    (async () => {
      try {
        const r = await fetch('/api/studio-ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, trace: options?.trace }), signal: options?.signal });
        if (!r.ok || !r.body) throw new Error(`desk returned ${r.status}`);
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (!line) continue;
            const o = JSON.parse(line);
            if (o.done) { tally(o.done); finish(o.done); } else { queue.push(o); wake?.(); }
          }
        }
        finish(failed('The desk closed the stream early.'));
      } catch (e: any) {
        finish(options?.signal?.aborted ? { ...failed('Cancelled'), status: 'cancelled' } : failed(e.message));
      } finally { ended = true; wake?.(); }
    })();
    return {
      complete,
      stream: {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length) { yield queue.shift()!; continue; }
            if (ended) return;
            await new Promise<void>((r) => (wake = r));
            wake = null;
          }
        },
      },
    };
  },
};

// JUNCO's own tools for the lead agent. Read-only: they call the same desk endpoints the widgets read, nothing writes.
function juncoTools(api: any): AgAiTool[] {
  const caseId = (s: any) => s.object({ dispute_id: s.string({ description: 'Dispute ID, for example PP-R-PBO-10190474' }) });
  return [
    api.defineAiTool({
      name: 'junco_explain_case',
      description: "Why JUNCO recommends what it does on one dispute: its decision, summary, each claim with the evidence it cites, the validator's problems, what would change its mind, and any held actions. Use this instead of guessing about a case.",
      params: caseId,
      async execute({ dispute_id }: { dispute_id: string }, ctx: any) {
        try {
          const c = await desk<CaseDetail>(`/api/cases/${encodeURIComponent(dispute_id)}`);
          const rec = c.saved?.recommendation;
          const ev = new Map(c.evidence.map((e) => [e.id, e]));
          const lines = [
            `${c.id}: ${c.reason}, ${money(c.amount, c.currency)}, status ${c.status}${c.due ? `, respond by ${c.due.slice(0, 10)}` : ''}.`,
            rec ? `JUNCO says: ${rec.decision}. ${rec.summary}` : 'JUNCO has not reviewed this case yet.',
            ...(rec?.claims ?? []).map((cl) => `- ${cl.text} [${cl.evidence_ids.map((id) => `${id}: ${ev.get(id)?.source ?? '?'} "${(ev.get(id)?.text ?? '').slice(0, 160)}"`).join('; ')}]`),
            ...(c.saved?.problems.length ? [`Validator problems: ${c.saved.problems.join('; ')}`] : []),
            ...(rec?.would_change_mind ? [`Would change its mind: ${rec.would_change_mind}`] : []),
            ...c.holds.filter((h) => h.status === 'pending').map((h) => `Waiting for the owner: ${h.method.replace(/_/g, ' ')} (${h.reason})`),
          ];
          return ctx.success(lines.join('\n'));
        } catch (e: any) { return ctx.error(`No case ${dispute_id}: ${e.message}`); }
      },
    }),
    api.defineAiTool({
      name: 'junco_policy_what_if',
      description: "Replays JUNCO's saved recommendations through the owner's policy gate with a different auto-offer limit (USD) and says how many cases JUNCO would then handle without asking. Changes nothing.",
      params: (s: any) => s.object({ offer_limit: s.number({ description: 'Auto-offer limit in USD, 0 to 500' }) }),
      async execute({ offer_limit }: { offer_limit: number }, ctx: any) {
        try {
          const now = await desk<any>('/api/policy');
          const w = await desk<any>('/api/policy/what-if', { method: 'POST', json: { ...now, offer_limit } });
          const was = await desk<any>('/api/policy/what-if', { method: 'POST', json: now });
          return ctx.success(`At a $${offer_limit} limit JUNCO would handle ${w.handled} of ${w.total} reviewed cases alone (today, at $${now.offer_limit}: ${was.handled} of ${was.total}).\n` +
            w.cases.map((c: any) => `- ${c.id}: ${c.decision}, ${c.handled ? 'runs' : `held (${c.reason})`}`).join('\n'));
        } catch (e: any) { return ctx.error(e.message); }
      },
    }),
    api.defineAiTool({
      name: 'junco_activity',
      description: "JUNCO's activity log for the last N days (default 7): every step it took on disputes and orders, what triggered it (a PayPal webhook, a scheduled check, the owner, the dashboard assistant) and the outcome. Step 'done' means JUNCO acted on its own inside the owner's policy; 'waiting for you' means it held an action for the owner.",
      params: (s: any) => s.object({ days: s.number({ description: 'How many days back, 1 to 30' }) }),
      async execute({ days }: { days: number }, ctx: any) {
        try {
          const since = Date.now() - Math.min(Math.max(days || 7, 1), 30) * 86400000;
          const { items } = await desk<{ items: Activity[] }>('/api/activity');
          const recent = items.filter((a) => Date.parse(a.at) >= since);
          // The log records a hold when it is made, not when the owner settles it, so say which are still open.
          const pending = await desk<Hold[]>('/api/holds');
          const open = pending.length ? pending.map((h) => `${h.args?.dispute_id ?? h.id} (${h.method.replace(/_/g, ' ')})`).join(', ') : 'none';
          return ctx.success(`${recent.length ? recent.map((a) => `${a.at.slice(0, 16).replace('T', ' ')} ${a.dispute_id} [${TRIGGER[a.trigger] ?? a.trigger}] ${a.step}: ${a.detail}`).join('\n') : 'Nothing in that period.'}\n\nHolds still waiting for the owner right now: ${open}. Any other 'waiting for you' entry above has since been approved or rejected.`);
        } catch (e: any) { return ctx.error(e.message); }
      },
    }),
    api.defineAiTool({
      name: 'junco_orders',
      description: "Paid orders JUNCO watches before any dispute exists (shipment watch): item, amount, ship-by time, tracking numbers on PayPal, and status (protected = tracking is on PayPal; watching = no tracking yet; at_risk = past ship-by or flagged, with the reason).",
      params: (s: any) => s.object({}),
      async execute(_args: unknown, ctx: any) {
        try {
          const { items } = await desk<{ items: any[] }>('/api/orders');
          return ctx.success(items.length ? items.map((o) => `${o.order_id || o.capture_id}: ${o.item ?? 'item'}, ${money(o.amount, o.currency)}, ${o.status}, ship by ${String(o.ship_by).slice(0, 10)}, tracking ${o.trackers?.length ? o.trackers.map((t: any) => `${t.number} (${t.status})`).join(', ') : 'none'}${o.reason ? `. ${o.reason}` : ''}`).join('\n') : 'No watched orders.');
        } catch (e: any) { return ctx.error(e.message); }
      },
    }),
    api.defineAiTool({
      name: 'junco_open_case',
      description: "Opens one dispute in the Desk's Case panel so the owner can read the evidence and act on it.",
      params: caseId,
      execute({ dispute_id }: { dispute_id: string }, ctx: any) { selectCase(dispute_id); return ctx.success(`Opened ${dispute_id} in the Case panel.`); },
    }),
  ];
}

// The same PayPal tools every JUNCO agent gets, through the same policy gate on the desk. A money action the policy
// holds lands on the Desk as a hold "asked by the dashboard assistant"; nothing moves without the owner.
let paypalTools: AgAiTool[] = [];
async function loadPayPalTools() {
  const list = await desk<{ name: string; description: string; inputSchema: any }[]>('/api/studio-ai/tools');
  paypalTools = list.map((t) => ({
    name: t.name, description: t.description, kind: 'client' as const,
    schema: () => ({ name: t.name, description: t.description, parameters: t.inputSchema }),
    async execute(call, ctx) {
      try { return ctx.success((await desk<{ text: string }>(`/api/studio-ai/tools/${encodeURIComponent(t.name)}`, { method: 'POST', json: call.args })).text); }
      catch (e: any) { return ctx.error(e.message); }
    },
  }));
}

// How JUNCO's tools read in the assistant panel.
export const aiToolDisplay = {
  junco_explain_case: { label: ({ args }: any) => ({ text: `Read JUNCO's reasoning on ${args.dispute_id ?? 'a case'}` }) },
  junco_policy_what_if: { label: ({ args }: any) => ({ text: 'Replay cases under a different limit', pill: args.offer_limit === undefined ? undefined : `$${args.offer_limit}` }) },
  junco_open_case: { label: ({ args }: any) => ({ text: `Open ${args.dispute_id ?? 'a case'}` }) },
  junco_activity: { label: ({ args }: any) => ({ text: "Read JUNCO's activity log", pill: args.days ? `${args.days} days` : undefined }) },
  junco_orders: { label: () => ({ text: 'Read the shipment watch' }) },
  // Studio's own tools without built-in wording (v3.14 item 5: the trace should read as work, never as a tool name).
  view_report: { label: ({ status, result }: any) => ({ text: status !== 'done' ? 'Reading the dashboard' : result?.success === false ? 'Could not read the dashboard' : 'Read the dashboard' }) },
  rename_thread: { hidden: true },
};
// PayPal tool calls read as their action and case: "Accept dispute claim, PP-R-...". Studio looks labels up by name,
// so the gated tool set is listed here (the names the desk's MCP server serves).
const PAYPAL_TOOLS = ['list_disputes', 'get_dispute', 'accept_dispute_claim', 'provide_dispute_evidence', 'make_dispute_offer', 'send_dispute_message', 'provide_dispute_supporting_info', 'add_order_tracking'];
const said = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');
export const aiToolDisplayAll: Record<string, any> = {
  ...Object.fromEntries(PAYPAL_TOOLS.map((name) => [name, { label: ({ args }: any) => ({
    text: `${said(name)}${args?.dispute_id ? `, ${args.dispute_id}` : ''}`,
    pill: args?.offer_amount?.value ? `$${args.offer_amount.value}` : undefined,
  }) }])),
  ...aiToolDisplay,
};

const LEAD_NOTE = "\n\nThis dashboard is JUNCO, a PayPal dispute desk. For why JUNCO recommends something on a case, call junco_explain_case and quote its evidence; never guess. For what a policy change would do, call junco_policy_what_if. For what JUNCO did, call junco_activity. For watched orders and tracking, call junco_orders. To show a case, call junco_open_case. You may act on a dispute only when the owner asks you to, and only with the PayPal tools listed. Every one of them passes through the owner's policy gate: an action the policy holds waits on the Desk for the owner's approval, and you must then say plainly that it is waiting for them and has not happened yet. Never claim money moved unless the tool result says it did.";

let registered = false;
export function aiSetup() {
  if (!registered) { AgStudioModuleRegistry.registerModules([AgStudioAiModule]); registered = true; }
  return ({ api }: { api: any }) => {
    (window as any).__studio = api; // read by the reliability check (npm run check-studio-ai)
    const junco = juncoTools(api);
    void loadPayPalTools().catch((e) => console.warn('[studio-ai] PayPal tools unavailable', e.message));
    return createAiHarness(api, ({ builtIn }) => ({
      // Turn limits stop a confused agent looping on paid calls (one cold run once took 63 calls and 4 minutes).
      agents: (Object.keys(builtIn) as AgBuiltInAgentId[]).map((id) => directLlmRunner(id !== 'lead' ? { ...builtIn[id], adapter, maxTurns: 8 } : {
        ...builtIn.lead, adapter, maxTurns: 10,
        instructions: (ctx, p) => (builtIn.lead.instructions?.(ctx, p) ?? '') + LEAD_NOTE,
        tools: (ctx, p) => [...(builtIn.lead.tools?.(ctx, p) ?? []), ...junco, ...paypalTools],
      })),
      primary: 'lead',
      promptStarters: [{ label: QUESTION, prompt: PROMPT }, { label: DID, prompt: DID }, { label: TRACKING, prompt: TRACKING }],
    }));
  };
}
