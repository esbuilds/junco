// AG Studio's AI assistant, browser half. Studio runs its own agents and dashboard tools here; each model turn goes to
// the desk (/api/studio-ai), which calls Claude and streams Studio's events back. No API key in the browser.
import { AgStudioAiModule, AgStudioModuleRegistry, createAiHarness, directLlmRunner, type AgAiEvent, type AgAiTool, type AgBuiltInAgentId, type AgLlmAdapter, type AgLlmResponse } from 'ag-studio';
import { api as desk, money, TRIGGER, type Activity, type CaseDetail, type Hold } from './api';
import { selectCase } from './store';
import { GateCard, gateData } from './widgets/GateCard';
import type { Incident, IncidentSummary, WhatIf } from '../../src/incident-types';

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
      name: 'junco_get_incident',
      description: "BLACK BOX: one AI purchase start to finish from JUNCO's records: what the buyer allowed, what the shopping agent bought, every event oldest first (LIVE = PayPal's sandbox did it, RECORDED = the desk's own record), the money-move counts and what the records lack. Without an id, lists the incidents.",
      params: (s: any) => s.object({ incident_id: s.string({ description: 'Incident id (the buyer transaction id); empty to list incidents' }) }),
      async execute({ incident_id }: { incident_id: string }, ctx: any) {
        try {
          if (!incident_id) return ctx.success((await desk<IncidentSummary[]>('/api/incidents')).map((i) => `${i.id}: ${i.title}${i.dispute_id ? `, dispute ${i.dispute_id}` : ''}`).join('\n') || 'No incidents.');
          const i = await desk<Incident>(`/api/incident/${encodeURIComponent(incident_id)}`);
          const LIVE = ['purchase', 'payment', 'dispute', 'paypal', 'webhook'];
          return ctx.success([
            `${i.id}: ${i.title}`,
            `Buyer allowed: ${i.authority ? `${i.authority.instruction} (budget ${i.authority.budget}, ${i.authority.agent})` : 'not in the records'}`,
            `Bought: ${i.purchase ? `${i.purchase.sku} ${i.purchase.listing}, ${i.purchase.amount}, because ${i.purchase.reason}` : 'not in the records'}`,
            `Money moves: ${i.counts.proposed} proposed, ${i.counts.approved} approved, ${i.counts.executed} executed, ${i.counts.outcome_unknown} outcome unknown`,
            ...i.events.map((e) => `${e.at.slice(0, 16).replace('T', ' ')} [${LIVE.includes(e.kind) || (e.kind === 'gate' && !!e.ref?.rule?.startsWith('allow:')) ? 'LIVE' : 'RECORDED'}] ${e.id} ${e.actor}: ${e.summary}`),
            ...(i.missing.length ? [`Not in the records: ${i.missing.join(' ')}`] : []),
          ].join('\n'));
        } catch (e: any) { return ctx.error(`No incident ${incident_id}: ${e.message}`); }
      },
    }),
    api.defineAiTool({
      name: 'junco_incident_what_if',
      description: "BLACK BOX what-if: re-runs the owner's gate on one recorded money move from an incident (its gate or hold event id) with a different amount limit on its tool (refunds and dispute offers only), and says what the verdict would have been. Never reaches PayPal; changes nothing.",
      params: (s: any) => s.object({ incident_id: s.string({ description: 'Incident id' }), event_id: s.string({ description: "A gate or hold event id from junco_get_incident, like 'gate:2026-10-23T09:41:31.000Z'" }), max_amount: s.number({ description: 'Amount limit in USD, 0 to 10000' }) }),
      async execute({ incident_id, event_id, max_amount }: { incident_id: string; event_id: string; max_amount: number }, ctx: any) {
        try {
          const w = await desk<WhatIf>(`/api/incident/${encodeURIComponent(incident_id)}/what-if`, { method: 'POST', json: { event_id, max_amount } });
          return ctx.success(`WHAT-IF (${w.change}) on ${w.method}: was ${w.before.verdict} (${w.before.reason}), would be ${w.after.verdict} (${w.after.reason}). PayPal calls: ${w.paypal_calls}.`);
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
      // The gate's verdict rides along as data for the chat's gate card (v3.15 move 3).
      try { const { text } = await desk<{ text: string }>(`/api/studio-ai/tools/${encodeURIComponent(t.name)}`, { method: 'POST', json: call.args }); return ctx.success(text, gateData(text)); }
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
  junco_get_incident: { label: ({ args }: any) => ({ text: args.incident_id ? `Read incident ${args.incident_id}` : 'List AI purchase incidents' }) },
  junco_incident_what_if: { label: ({ args }: any) => ({ text: 'Re-run the gate on a recorded request', pill: args.max_amount === undefined ? 'WHAT-IF' : `WHAT-IF $${args.max_amount}` }) },
  // Studio's own tools without built-in wording (v3.14 item 5: the trace should read as work, never as a tool name).
  view_report: { label: ({ status, result }: any) => ({ text: status !== 'done' ? 'Reading the dashboard' : result?.success === false ? 'Could not read the dashboard' : 'Read the dashboard' }) },
  rename_thread: { hidden: true },
};
// PayPal tool calls read as their action and case: "Accept dispute claim, PP-R-...". Studio looks labels up by name,
// so the gated tool set is listed here (the names the desk's MCP server serves).
const PAYPAL_TOOLS = ['list_disputes', 'get_dispute', 'accept_dispute_claim', 'provide_dispute_evidence', 'make_dispute_offer', 'send_dispute_message', 'provide_dispute_supporting_info', 'add_order_tracking'];
const said = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');
// Writes open to a gate card (held, refused or allowed, with Approve and Reject on a hold); the row's pill says which.
const READS = new Set(['list_disputes', 'get_dispute']);
const PILL: Record<string, string> = { held: 'held for owner', refused: 'refused', allowed: 'allowed', failed: 'PayPal refused' };
export const aiToolDisplayAll: Record<string, any> = {
  ...Object.fromEntries(PAYPAL_TOOLS.map((name) => [name, { label: ({ args, result }: any) => ({
    text: `${said(name)}${args?.dispute_id ? `, ${args.dispute_id}` : ''}${args?.offer_amount?.value ? `, $${args.offer_amount.value}` : ''}`,
    pill: !READS.has(name) && result?.success ? PILL[result.data?.gate] : undefined,
  }), ...(!READS.has(name) && { detail: GateCard }) }])),
  ...aiToolDisplay,
};

const LEAD_NOTE = "\n\nThis dashboard is JUNCO, a PayPal dispute desk. For why JUNCO recommends something on a case, call junco_explain_case and quote its evidence; never guess. For what a policy change would do, call junco_policy_what_if. For what JUNCO did, call junco_activity. For watched orders and tracking, call junco_orders. To show a case, call junco_open_case. For an AI shopping agent's purchase (what it was allowed, what it bought, what happened after), call junco_get_incident and quote its events; for what a different amount limit would have done to a recorded request, call junco_incident_what_if and say it is a what-if that never reached PayPal. Ask the widget agent for a chart only from numbers those tools returned. You may act on a dispute only when the owner asks you to, and only with the PayPal tools listed. Every one of them passes through the owner's policy gate: an action the policy holds waits on the Desk for the owner's approval, and you must then say plainly that it is waiting for them and has not happened yet. Never claim money moved unless the tool result says it did.";

let registered = false;
export function aiSetup() {
  if (!registered) { AgStudioModuleRegistry.registerModules([AgStudioAiModule]); registered = true; }
  return ({ api }: { api: any }) => {
    (window as any).__studio = api; // read by the reliability check (npm run check-studio-ai)
    const junco = juncoTools(api);
    void loadPayPalTools().catch((e) => console.warn('[studio-ai] PayPal tools unavailable', e.message));
    return createAiHarness(api, ({ builtIn }) => ({
      // Turn limits stop a confused agent looping on paid calls (one cold run once took 63 calls and 4 minutes).
      // JUNCO is its own agent (id 'junco', where every thread starts): the built-in lead's instructions and Studio tools,
      // JUNCO's tools, and its own delegate_to to Studio's built-in specialists. The built-ins stay registered unchanged.
      agents: [
        ...(Object.keys(builtIn) as AgBuiltInAgentId[]).map((id) => directLlmRunner({ ...builtIn[id], adapter, maxTurns: id === 'lead' ? 10 : 8 })),
        directLlmRunner({
          ...builtIn.lead, id: 'junco', adapter, maxTurns: 10, name: 'JUNCO',
          description: "JUNCO's dispute assistant: answers about cases from JUNCO's evidence, asks Studio's agents for charts and widgets, and acts on PayPal only through the owner's policy gate.",
          instructions: (ctx, p) => (builtIn.lead.instructions?.(ctx, p) ?? '') + LEAD_NOTE,
          tools: (ctx, p) => [...(builtIn.lead.tools?.(ctx, p) ?? []).filter((t) => t.name !== 'delegate_to'),
            ctx.tools.delegateTo(['data', 'widget', 'page', 'planning']), ...junco, ...paypalTools],
        }),
      ],
      primary: 'junco',
      promptStarters: [{ label: QUESTION, prompt: PROMPT }, { label: DID, prompt: DID }, { label: TRACKING, prompt: TRACKING }],
    }));
  };
}
