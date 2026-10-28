// BLACK BOX (Oct 28): one agent purchase's whole story, joined from the desk's own records, and the gate re-run on a
// recorded request under one changed rule. Pure reads of .junco/*.json; nothing here is written, asked of a model or sent
// to PayPal. By construction this module imports no PayPal client: gate.ts and store-dispute.ts only read files here
// (check-incident asserts the import list and that a what-if reaches no network).
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { decide, loadActivePolicy, readBudgets, readHolds, readMoves, MONEY, type Budget, type Hold, type Move, type Policy } from './gate.js';
import { readPool, readRuns, type PoolEntry } from './store-dispute.js';
import type { Incident, IncidentEvent, IncidentSummary, WhatIf } from './incident-types.js';

const read = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
// agent.ts and desk.ts own these files; read here directly because agent.ts imports the PayPal client.
type Activity = { at: string; dispute_id: string; trigger: string; step: string; detail: string };
const readActivity = () => read<Activity[]>('.junco/activity.json', []);
const holdTags = () => read<Record<string, string>>('.junco/hold-tags.json', {});

// Who proposed a move, from the desk's hold tag or the gate log's source ('desk agent' is JUNCO's own agent).
const who = (tag?: string) => (!tag ? 'unknown caller' : tag === 'desk agent' ? 'JUNCO agent' : tag);
const amountText = (args: any) => { const a = args?.offer_amount ?? args?.amount; return a?.value ? `${a.value} ${a.currency_code ?? ''}`.trim() : null; };
const said = (method: string, args: any) => `${method.replace(/_/g, ' ')}${amountText(args) ? ` of ${amountText(args)}` : ''}`;
const parse = (s?: string) => { try { return JSON.parse(s ?? ''); } catch { return null; } };
const APPROVED = ['executing', 'completed', 'failed', 'unknown', 'approved'];

// Pool agent entries are the incidents: an order a shopping agent placed for the buyer.
const entries = () => readPool().filter((p) => p.agent);
// A buyer_txn can have a failed filing before a good one; the run that opened a dispute wins.
const runOf = (txn: string) => { const rs = readRuns().filter((r) => r.buyer_txn === txn); return rs.find((r) => r.dispute_id) ?? rs.at(-1); };

function build(p: PoolEntry): Incident {
  const a = p.agent!, run = runOf(p.buyer_txn), dispute_id = run?.dispute_id ?? null;
  const capture_id = a.capture_id || undefined;
  const missing: string[] = [];
  if (!p.order_id) missing.push('order id: the pool entry has none');
  if (!capture_id) missing.push(`capture id: the pool entry records order ${p.order_id ?? '(none)'} but not its capture, so refunds on this payment (they name the capture) cannot be matched to this purchase`);
  if (!dispute_id) missing.push(run?.error ? `dispute: filing failed (${run.error})` : 'dispute: none filed for this purchase yet');
  const mine = (args: any) => (!!dispute_id && args?.dispute_id === dispute_id) || (!!capture_id && args?.capture_id === capture_id);

  // pool amounts are USD: pool.ts only places USD orders
  const events: IncidentEvent[] = [{ id: `purchase:${p.buyer_txn}`, at: p.added, kind: 'purchase', actor: 'shopping agent', source: 'pool',
    summary: `${a.agent} bought ${a.sku} for ${p.amount} USD, asked "${a.instruction}" with a ${a.budget} USD budget, paying with the PayPal account the buyer saved for the store.`,
    ref: { buyer_txn: p.buyer_txn, ...(p.order_id && { order_id: p.order_id }), ...(capture_id && { capture_id }) } }];
  if (run) events.push({ id: `dispute:${dispute_id ?? run.at}`, at: run.at, kind: 'dispute', actor: 'buyer', source: 'store-runs',
    summary: dispute_id ? `The buyer disputed the order as not as described; PayPal opened ${dispute_id}.` : `Filing the buyer's dispute failed: ${run.error ?? 'no dispute id recorded'}.`,
    ref: { buyer_txn: p.buyer_txn, ...(dispute_id && { dispute_id }) } });
  if (run?.leased_at) events.push({ id: `dispute:${dispute_id}:leased`, at: run.leased_at, kind: 'dispute', actor: 'desk visitor', source: 'store-runs',
    summary: `A desk visitor took the case${run.challenge ? ' for Break the mandate' : ''} and JUNCO started on it.`, ref: { ...(dispute_id && { dispute_id }) } });

  const ids = new Set([dispute_id, p.order_id, capture_id].filter(Boolean));
  for (const x of readActivity().filter((x) => ids.has(x.dispute_id)))
    events.push({ id: `agent:${x.at}`, at: x.at, kind: 'agent', actor: x.trigger === 'mcp' ? 'MCP client' : x.trigger === 'assistant' ? 'dashboard assistant' : 'JUNCO agent',
      source: 'activity', summary: `${x.step}: ${x.detail}`, ref: dispute_id ? { dispute_id } : undefined });

  const counts = { proposed: 0, approved: 0, executed: 0, outcome_unknown: 0 };
  const tags = holdTags();
  for (const h of readHolds().filter((h) => mine(h.args))) {
    const money = MONEY.includes(h.method), ref = { hold_id: h.id, ...(h.args?.dispute_id && { dispute_id: h.args.dispute_id }), ...(h.args?.capture_id && { capture_id: h.args.capture_id }) };
    if (money) { counts.proposed++; if (APPROVED.includes(h.status)) counts.approved++; if (h.status === 'completed') counts.executed++; if (h.status === 'unknown' || h.status === 'executing') counts.outcome_unknown++; }
    if (!tags[h.id]) missing.push(`who asked for hold ${h.id}: it carries no caller tag`);
    events.push({ id: `hold:${h.id}`, at: h.created, kind: 'hold', actor: who(tags[h.id]), source: 'holds',
      summary: `${who(tags[h.id])} asked for ${said(h.method, h.args)}; the gate held it for the owner (${h.reason}).`, ref: { ...ref, rule: h.reason } });
    if (h.recheck) events.push({ id: `webhook:${h.id}`, at: h.recheck.at, kind: 'webhook', actor: 'PayPal', source: 'holds',
      summary: `PayPal reported ${h.recheck.event} after this was held${h.recheck.refund ? `, including refund ${h.recheck.refund.id}` : ''}; approval re-reads PayPal first.`,
      ref: { ...ref, ...(h.recheck.refund && { refund_id: h.recheck.refund.id }) } });
    if (h.status === 'pending') continue;
    const out = parse(h.result);
    if (h.ran) events.push({ id: `approval:${h.id}`, at: h.ran, kind: 'approval', actor: 'owner', source: 'holds', summary: `The owner approved ${said(h.method, h.args)}.`, ref });
    else {
      // The hold store keeps a run time for approvals only; a rejection or a stale refusal has none.
      missing.push(`when hold ${h.id} was ${h.status}: the hold store records no time for it`);
      const why = out?.error?.message ?? out?.settled;
      events.push({ id: `approval:${h.id}`, at: h.created, kind: 'approval', actor: out?.settled ? 'JUNCO (system)' : 'owner', source: 'holds', ref,
        summary: h.status === 'rejected' ? 'The owner rejected it; nothing was sent to PayPal (time not recorded).' : `Not run${why ? `: ${String(why).replace(/^Not run: /, '')}` : ''}; nothing was sent to PayPal (time not recorded).` });
    }
    if (!h.ran) continue;
    // PayPal's own answer, as the hold stored it. A refund's is the refund object: its id and status.
    const refund = h.method === 'create_refund' && out?.id ? { id: String(out.id), status: out.status ? String(out.status) : undefined } : undefined;
    if (h.method === 'create_refund' && h.status === 'completed' && !refund) missing.push(`PayPal's refund id for hold ${h.id}: the stored result has none`);
    if (h.status === 'unknown' || h.status === 'executing') missing.push(`whether hold ${h.id} reached PayPal: its outcome is unknown (re-check PayPal)`);
    const text = h.status === 'completed' ? (refund ? `PayPal created refund ${refund.id}${refund.status ? ` (${refund.status})` : ''}.` : out?.settled ? `PayPal accepted it (${out.settled}).` : 'PayPal accepted it.')
      : h.status === 'failed' ? `PayPal refused it${out?.error?.message ? `: ${String(out.error.message).slice(0, 200)}` : ''}.`
      : h.status === 'approved' ? 'Approved; the outcome was not recorded.' : 'Sent to PayPal; the outcome is unknown.';
    events.push({ id: `paypal:${h.id}`, at: h.ran, kind: 'paypal', actor: 'PayPal', source: 'holds', summary: text, ref: { ...ref, ...(refund && { refund_id: refund.id }) } });
  }
  for (const m of readMoves().filter((m) => mine(m.args))) {
    counts.proposed++;
    if (m.verdict === 'allow') { counts.approved++; if (!m.error) counts.executed++; }
    events.push({ id: `gate:${m.at}`, at: m.at, kind: 'gate', actor: who(m.source), source: 'gate-log',
      summary: `${who(m.source)} asked for ${said(m.method, m.args)}; the gate ${m.verdict === 'allow' ? 'allowed' : 'denied'} it (${m.reason})${m.verdict === 'deny' ? ', nothing sent' : m.error ? `, and PayPal refused it: ${m.error.slice(0, 200)}` : ', and PayPal accepted it'}.`,
      ref: { ...(m.args?.dispute_id && { dispute_id: m.args.dispute_id }), ...(m.args?.capture_id && { capture_id: m.args.capture_id }), rule: m.reason } });
  }
  events.sort((x, y) => x.at.localeCompare(y.at));
  return {
    id: p.buyer_txn, title: `Agent bought ${a.sku} for "${a.instruction}"`,
    authority: { instruction: a.instruction, budget: `${a.budget} USD`, agent: a.agent },
    purchase: { sku: a.sku, listing: a.listing, reason: a.reason, amount: `${p.amount} USD`, ...(p.order_id && { order_id: p.order_id }), ...(capture_id && { capture_id }) },
    dispute_id, events, counts, missing,
  };
}

export function listIncidents(): IncidentSummary[] {
  return entries().map(build).map(({ id, title, dispute_id, counts, events }) => ({ id, title, dispute_id, counts, last_at: events.at(-1)!.at }))
    .sort((a, b) => b.last_at.localeCompare(a.last_at));
}
export function buildIncident(id: string): Incident | null {
  const p = entries().find((e) => e.buyer_txn === id);
  return p ? build(p) : null;
}

// One changed rule: the amount limit on the recorded call's own tool, or the standing approval (budget) on its dispute.
// null budget removes it. Only these two, so `after` differs from `before` for one stated reason.
export type Change = { max_amount: number } | { budget: number | null };

// The recorded request behind an event: a held call (hold:<id>) or an allowed or denied one in the gate log (gate:<at>).
function recorded(eventId: string): { method: string; args: any; verdict: string; reason: string } | null {
  const [kind, ...rest] = eventId.split(':'), key = rest.join(':');
  if (kind === 'hold') { const h: Hold | undefined = readHolds().find((x) => x.id === key); return h ? { method: h.method, args: h.args, verdict: 'hold', reason: h.reason } : null; }
  if (kind === 'gate') { const m: Move | undefined = readMoves().find((x) => x.at === key); return m ? { method: m.method, args: m.args, verdict: m.verdict, reason: m.reason } : null; }
  return null;
}

// Re-runs decide() (gate.ts) on the recorded request: `before` is what the gate decided then, `after` is today's policy
// and standing approvals with the one change. If today's rules alone already decide differently, `after` says so.
export function whatIf(eventId: string, change: Change): WhatIf {
  const r = recorded(eventId);
  if (!r) throw new Error(`No recorded request for ${eventId}; what-ifs take a hold:<id> or gate:<time> event id from junco_get_incident`);
  const policy = loadActivePolicy(), budgets = readBudgets();
  const cur = r.args?.offer_amount?.currency_code ?? r.args?.amount?.currency_code ?? 'USD';
  let p: Policy = policy, b: Record<string, Budget> = budgets, text: string;
  if ('max_amount' in change) {
    if (!['make_dispute_offer', 'create_refund'].includes(r.method)) throw new Error(`${r.method} has no amount limit to change; limit what-ifs apply to make_dispute_offer and create_refund`);
    const rule = policy.tools[r.method];
    const old = typeof rule === 'object' ? `${rule.max_amount} ${cur}` : `none (${rule ?? policy.default})`;
    const over = typeof rule === 'object' ? rule.over : rule === 'deny' ? 'deny' : 'hold';
    p = { ...policy, tools: { ...policy.tools, [r.method]: { max_amount: change.max_amount, over } } };
    text = `${r.method} limit ${old} -> ${change.max_amount} ${cur}`;
  } else {
    const id = r.args?.dispute_id;
    if (!id) throw new Error(`a standing approval covers one dispute; this ${r.method} names no dispute_id`);
    const was = budgets[id], next = { ...budgets };
    if (change.budget === null) delete next[id];
    else {
      // Accepting a claim moves the whole disputed amount: the existing budget's, else the held case's, else the pool order's.
      const run = readRuns().find((x) => x.dispute_id === id), pool = run && readPool().find((x) => x.buyer_txn === run.buyer_txn);
      const held = readHolds().find((h) => h.args?.dispute_id === id && h.case?.amount)?.case?.amount;
      const amount = was?.amount ?? (held ? parseFloat(held) : pool ? Number(pool.amount) : NaN);
      if (r.method === 'accept_dispute_claim' && Number.isNaN(amount)) throw new Error(`the disputed amount for ${id} is not recorded, so an accept cannot be measured against a budget`);
      next[id] = { limit: change.budget, amount, currency: was?.currency ?? cur, set_at: 'what-if' };
    }
    b = next;
    text = `standing approval for ${id} ${was ? `${was.limit} ${was.currency}` : 'none'} -> ${change.budget === null ? 'none' : `${change.budget} ${cur}`}`;
  }
  const today = decide(policy, r.method, r.args, budgets), after = decide(p, r.method, r.args, b);
  return { mode: 'what-if', event_id: eventId, method: r.method, args: r.args, change: text,
    before: { verdict: r.verdict, reason: r.reason },
    after: { verdict: after.verdict, reason: today.verdict === r.verdict ? after.reason : `${after.reason} (today's rules without the change already give ${today.verdict}: ${today.reason})` },
    paypal_calls: 0 };
}

const reply = (f: () => unknown) => {
  try { return { content: [{ type: 'text' as const, text: JSON.stringify(f() ?? { error: { message: 'No incident with that id; junco_list_incidents lists them' } }) }] }; }
  catch (e: any) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { message: e.message } }) }] }; }
};

// The connector's investigation tools. Read only (policy.json classes them read), so the gate passes them straight through.
export function addIncidentTools(server: any) {
  server.registerTool('junco_list_incidents', {
    description: 'List AI purchases this store recorded: orders a shopping agent placed for a buyer with PayPal, newest activity first. '
      + 'Each has an id (the buyer transaction id), a title, the PayPal dispute id if the buyer disputed it, and counts of money moves '
      + '(proposed, approved, executed, outcome unknown). Start here, then call junco_get_incident with an id. Read only; nothing is sent to PayPal.',
    inputSchema: {},
  }, async () => reply(listIncidents));
  server.registerTool('junco_get_incident', {
    description: "One AI purchase's full record, joined from the store's own logs, not from any model: what the buyer allowed the agent "
      + '(instruction and budget), what it bought and why, the dispute, and every event oldest first (the purchase, the dispute, JUNCO\'s '
      + 'agent steps, each money move the gate held, allowed or denied with the rule it applied, the owner\'s decision, and PayPal\'s answer '
      + 'such as a refund id). `missing` lists facts the records do not have; treat them as unknown, never guess them. Event ids starting '
      + 'hold: or gate: are recorded gate decisions you can pass to junco_what_if. Read only.',
    inputSchema: { id: z.string().regex(/^[A-Z0-9]{17}$/).describe('Buyer transaction id from junco_list_incidents') },
  }, async ({ id }: { id: string }) => reply(() => buildIncident(id)));
  server.registerTool('junco_what_if', {
    description: "Re-run JUNCO's gate on one recorded request under one changed rule, to see what would have happened. Give the event id "
      + '(hold:<id> or gate:<time> from junco_get_incident) and exactly one change: max_amount sets the amount limit on that call\'s tool '
      + '(make_dispute_offer or create_refund; below it the gate allows, above it holds), or budget sets the standing approval on its '
      + 'dispute (JUNCO may act alone on moves up to it; null removes it). Returns before (what the gate decided then) and after. '
      + 'This is a simulation: it never calls PayPal and changes no rule. To change a rule for real, propose it to the owner.',
    inputSchema: {
      event_id: z.string().regex(/^(hold|gate):[\w:.-]{1,40}$/),
      max_amount: z.number().min(0).max(100000).optional(),
      budget: z.number().min(0).max(100000).nullable().optional(),
    },
  }, async ({ event_id, max_amount, budget }: { event_id: string; max_amount?: number; budget?: number | null }) => reply(() => {
    if ((max_amount === undefined) === (budget === undefined)) throw new Error('give exactly one change: max_amount or budget');
    return whatIf(event_id, max_amount !== undefined ? { max_amount } : { budget: budget! });
  }));
}
