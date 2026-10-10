// Approval gate: every tool call on the MCP server (stock PayPal tools and JUNCO's) is allowed, held for the owner, or denied by policy.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mirror } from './persist.js';

export type Verdict = 'allow' | 'hold' | 'deny';
// Tool classes (T1): 'read' runs and changes nothing; 'allow' is an allowed write; 'hold' waits for the owner;
// a limit runs up to max_amount; 'hidden' is not exposed at all. A tool with no entry gets the default, which is deny.
export type Rule = Verdict | 'read' | 'hidden' | { max_amount: number; over: Verdict };
export type Policy = { default: Verdict; tools: Record<string, Rule>; ship_within_days?: number };
export type CaseState = { stage: string; amount: string };
// T2 lifecycle: pending, then rejected / stale, or executing then completed, failed or unknown. 'approved' is only on
// holds from before the lifecycle; the desk never shows it as done. 'unknown' re-reads PayPal to settle, never re-runs.
export type HoldStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'unknown' | 'approved' | 'rejected' | 'stale';
export type Hold = { id: string; method: string; args: any; reason: string; created: string; status: HoldStatus; result?: string; case?: CaseState; origin?: string; before?: Trail };

// PayPal link rel each dispute write needs. JUNCO's own tools check it again in run(); the stock accept does not.
const REL: Record<string, string> = {
  accept_dispute_claim: 'accept_claim', make_dispute_offer: 'make_offer', send_dispute_message: 'send_message',
  provide_dispute_evidence: 'provide_evidence', provide_dispute_supporting_info: 'provide_supporting_info',
};
const caseState = (d: any): CaseState => ({ stage: d.dispute_life_cycle_stage, amount: `${d.dispute_amount?.value} ${d.dispute_amount?.currency_code}` });

// Why an approval must not run now, or null. The owner approved the case as it was when held; a case that moved on needs asking again.
export function staleReason(h: Hold, d: any): string | null {
  if (d.status === 'RESOLVED') return `the case is already resolved`;
  const now = caseState(d);
  if (h.case && h.case.stage !== now.stage) return `the case moved from ${h.case.stage} to ${now.stage} since this was held`;
  if (h.case && h.case.amount !== now.amount) return `the disputed amount changed from ${h.case.amount} to ${now.amount} since this was held`;
  const rel = REL[h.method];
  if (rel && !(d.links ?? []).some((l: any) => l.rel === rel)) return `PayPal no longer allows ${rel} on this case`;
  return null;
}

// What a write leaves on the case, read before it runs. If the call's outcome is unknown, a re-read compares against it.
export type Trail = { status: string; messages: number; evidences: number; info: number; offers: number; rels: string[] };
const trail = (d: any): Trail => ({ status: d.status, messages: d.messages?.length ?? 0, evidences: d.evidences?.length ?? 0,
  info: d.supporting_info?.length ?? 0, offers: d.offer?.history?.length ?? 0, rels: (d.links ?? []).map((l: any) => l.rel) });
// Did this write land? true / false from the re-read, null when the method leaves nothing on the case we can compare.
export function landed(method: string, before: Trail, d: any): boolean | null {
  const now = trail(d);
  switch (method) {
    case 'accept_dispute_claim': return now.status === 'RESOLVED' || now.status !== before.status || !now.rels.includes('accept_claim');
    case 'send_dispute_message': return now.messages > before.messages;
    case 'make_dispute_offer': return now.offers > before.offers || now.status !== before.status;
    case 'provide_dispute_evidence': return now.evidences > before.evidences;
    case 'provide_dispute_supporting_info': return now.info > before.info;
    default: return null;
  }
}
// A tool result is JSON text; a PayPal refusal carries an error object. A dropped connection means the write may have landed.
const UNKNOWN = new Set(['hosted_unavailable']);
const errorOf = (t?: string) => { try { return JSON.parse(t ?? '').error; } catch { return undefined; } };

export const loadPolicy = (path = 'policy.json'): Policy => JSON.parse(readFileSync(path, 'utf8'));

// Owner edits from the desk live in .junco/policy.json (mirrored to Postgres); policy.json in the repo stays the default.
const SAVED_POLICY = '.junco/policy.json';
// Saved edits only cover owner-editable tools, so the repo's default and its newer tool entries always apply.
export const loadActivePolicy = (): Policy => {
  const repo = loadPolicy();
  try { const saved = loadPolicy(SAVED_POLICY); return { ...saved, default: repo.default, tools: { ...repo.tools, ...saved.tools } }; } catch { return repo; }
};
// One line per tool for the Policy page matrix.
export function toolClass(policy: Policy, name: string): string {
  const r = policy.tools[name];
  if (r === undefined) return policy.default === 'deny' ? 'denied (unclassified)' : `${policy.default} (unclassified)`;
  if (typeof r === 'object') return `allowed write up to ${r.max_amount}, then ${r.over}`;
  return { read: 'read', allow: 'allowed write', hold: 'hold', deny: 'denied', hidden: 'not exposed' }[r];
}
export function savePolicy(p: Policy | null) {
  mkdirSync('.junco', { recursive: true });
  const next = p ?? loadPolicy(); // null resets to the repo default
  writeFileSync(SAVED_POLICY, JSON.stringify(next, null, 2)); mirror(SAVED_POLICY, next);
  return next;
}

// Money a call would move, if the tool has an amount field.
const amountOf = (args: any): number | null => {
  const v = args?.offer_amount?.value ?? args?.amount?.value ?? args?.amount;
  return v == null ? null : Number(v);
};

// Standing approvals: the owner lets JUNCO handle one dispute on its own, as long as an action moves at most `limit`.
// Accepting a claim refunds the whole disputed amount, so it counts as `amount`.
export type Budget = { limit: number; amount: number; currency: string; set_at: string };
const BUDGETS = '.junco/budgets.json';
export const readBudgets = (): Record<string, Budget> => { try { return JSON.parse(readFileSync(BUDGETS, 'utf8')); } catch { return {}; } };
export function setBudget(id: string, b: Budget | null) {
  const all = readBudgets();
  if (b) all[id] = b; else delete all[id];
  mkdirSync('.junco', { recursive: true }); writeFileSync(BUDGETS, JSON.stringify(all, null, 2)); mirror(BUDGETS, all);
}
export const movesMoney = (method: string, args: any, b: Budget): number =>
  method === 'accept_dispute_claim' ? b.amount : amountOf(args) ?? 0;

export function decide(policy: Policy, method: string, args: any, budgets: Record<string, Budget> = {}): { verdict: Verdict; reason: string } {
  const b = args?.dispute_id ? budgets[args.dispute_id] : undefined;
  if (b && movesMoney(method, args, b) <= b.limit)
    return { verdict: 'allow', reason: `within the ${b.limit} ${b.currency} standing approval for ${args.dispute_id}` };
  const rule = policy.tools[method];
  if (rule === undefined) return { verdict: policy.default, reason: `${method} not in policy, default ${policy.default}` };
  if (rule === 'read') return { verdict: 'allow', reason: `policy: ${method} only reads` };
  if (rule === 'hidden') return { verdict: 'deny', reason: `policy: ${method} is not exposed` };
  if (typeof rule === 'string') return { verdict: rule, reason: `policy: ${method} = ${rule}` };
  const amt = amountOf(args);
  if (amt === null || Number.isNaN(amt)) return { verdict: 'hold', reason: `${method} has an amount limit but no readable amount` };
  return amt <= rule.max_amount
    ? { verdict: 'allow', reason: `${amt} is within the ${rule.max_amount} limit for ${method}` }
    : { verdict: rule.over, reason: `${amt} is over the ${rule.max_amount} limit for ${method}` };
}

// Holds live in one JSON file, mirrored to Postgres when DATABASE_URL is set (persist.ts). One writer process.
const HOLDS = '.junco/holds.json';
export const readHolds = (): Hold[] => { try { return JSON.parse(readFileSync(HOLDS, 'utf8')); } catch { return []; } };
const writeHolds = (h: Hold[]) => { mkdirSync('.junco', { recursive: true }); writeFileSync(HOLDS, JSON.stringify(h, null, 2)); mirror(HOLDS, h); };

// Ask the owner directly: a pending hold for an action JUNCO wants but won't take on its own (e.g. a negotiation that
// hit its ceiling). Approving it runs the tool through the same path as any other hold.
export function requestApproval(method: string, args: any, reason: string): Hold {
  const hold: Hold = { id: randomUUID().slice(0, 8), method, args, reason, created: new Date().toISOString(), status: 'pending' };
  writeHolds([...readHolds(), hold]);
  return hold;
}

// Extra checks that can refuse before policy is asked (the desk adds case leases). 'call' is a tool call, before policy;
// 'decide' is the owner approving or rejecting a hold. Reads are never guarded.
// ponytail: one process-wide list; pass guards per gate if a process ever runs two unrelated desks.
export type Guard = (method: string, args: any, phase: 'call' | 'decide') => string | null;
export const guards: Guard[] = [];
const guarded = (method: string, args: any, phase: 'call' | 'decide') => { for (const g of guards) { const why = g(method, args, phase); if (why) return why; } return null; };

// Pending holds on cases PayPal has resolved can never run (T2 would mark them stale on approval). The system settles
// them so they stop asking the owner.
export async function settleResolved(getCase: (id: string) => Promise<any>) {
  const holds = readHolds();
  let changed = 0;
  for (const h of holds.filter((x) => x.status === 'pending' && x.args?.dispute_id)) {
    const d = await getCase(h.args.dispute_id).catch(() => null);
    if (d?.status !== 'RESOLVED') continue;
    h.status = 'stale'; h.result = JSON.stringify({ settled: 'by the system: the case was resolved, so this can never run. Nothing was sent to PayPal.' });
    changed++;
  }
  if (changed) writeHolds(holds);
  return changed;
}

type Handler = (args: any, extra: any) => Promise<any>;
const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });

// getCase reads a dispute from PayPal; without it, approvals run the stored call with no re-read (offline checks).
// origin tags holds from a server other than the desk's own (PayPal hosted), so approval runs on the same server.
export function gate(server: any, policy: Policy, onHold?: (h: Hold) => void, getCase?: (id: string) => Promise<any>, origin?: string) {
  // ponytail: _registeredTools is private SDK state (checked on @modelcontextprotocol/sdk 1.32); re-check on upgrade
  const tools: Record<string, { handler: Handler; update: (u: { callback: Handler }) => void }> = server._registeredTools;
  const originals: Record<string, Handler> = {};
  for (const [name, tool] of Object.entries(tools)) {
    originals[name] = tool.handler;
    if (policy.tools[name] === 'hidden') (tool as any).disable(); // not listed; a direct call still gets the gate's deny
    tool.update({
      callback: async (args, extra) => {
        const refused = policy.tools[name] !== 'read' && guarded(name, args, 'call');
        if (refused) return text({ error: { type: 'denied_by_guard', message: `Not allowed: ${refused}` } });
        const { verdict, reason } = decide(policy, name, args, readBudgets());
        if (verdict === 'allow') return originals[name](args, extra);
        if (verdict === 'deny') return text({ error: { type: 'denied_by_policy', message: reason } });
        const hold: Hold = { id: randomUUID().slice(0, 8), method: name, args, reason, created: new Date().toISOString(), status: 'pending', ...(origin && { origin }) };
        if (getCase && args?.dispute_id) hold.case = await getCase(args.dispute_id).then(caseState, () => undefined);
        writeHolds([...readHolds(), hold]);
        onHold?.(hold);
        return text({ held: true, hold_id: hold.id, reason, next: 'Not executed. The owner must approve this action.' });
      },
    });
  }

  async function resolve(id: string, approve: boolean): Promise<Hold> {
    const holds = readHolds();
    const h = holds.find((x) => x.id === id);
    if (!h) throw new Error(`No hold ${id}`);
    if (h.status !== 'pending') throw new Error(`Hold ${id} is already ${h.status}`);
    const refused = guarded(h.method, h.args, 'decide');
    if (refused) throw Object.assign(new Error(`Not allowed: ${refused}.`), { code: 403 });
    if (!approve) { h.status = 'rejected'; writeHolds(holds); return h; }
    // Approval runs only the stored method and args, and only if the case is still the one the owner was shown.
    const d = getCase && h.args?.dispute_id ? await getCase(h.args.dispute_id) : null;
    const stale = d ? staleReason(h, d) : null;
    if (stale) {
      h.status = 'stale'; h.result = JSON.stringify({ error: { type: 'stale_hold', message: `Not run: ${stale}` } });
      writeHolds(holds);
      throw Object.assign(new Error(`Not run: ${stale}. Nothing was sent to PayPal.`), { code: 400 });
    }
    h.status = 'executing'; if (d) h.before = trail(d);
    writeHolds(holds); // mark first so a crash mid-call can't run it twice; a hold left executing settles like unknown
    try {
      const r = await originals[h.method](h.args, {});
      h.result = r.content?.[0]?.text;
      const err = errorOf(h.result);
      h.status = UNKNOWN.has(err?.type) ? 'unknown' : err || r.isError ? 'failed' : 'completed';
    } catch (e: any) {
      h.status = 'unknown'; h.result = JSON.stringify({ error: { type: 'outcome_unknown', message: e.message } });
    }
    writeHolds(holds);
    return h.status === 'unknown' ? settle(id) : h;
  }

  // Re-read PayPal and settle an unknown (or crashed executing) hold to completed or failed. Never runs the call again.
  async function settle(id: string): Promise<Hold> {
    const holds = readHolds();
    const h = holds.find((x) => x.id === id);
    if (!h) throw new Error(`No hold ${id}`);
    if (h.status !== 'unknown' && h.status !== 'executing') return h;
    const d = getCase && h.args?.dispute_id && h.before ? await getCase(h.args.dispute_id).catch(() => null) : null;
    const did = d ? landed(h.method, h.before!, d) : null;
    if (did === null) return h; // nothing to compare: stays unknown, the owner checks PayPal
    h.status = did ? 'completed' : 'failed';
    h.result = JSON.stringify({ settled: `PayPal's re-read shows the ${h.method.replace(/_/g, ' ')} ${did ? 'landed' : 'did not land'}`, was: h.result });
    writeHolds(holds);
    return h;
  }
  return { approve: (id: string) => resolve(id, true), reject: (id: string) => resolve(id, false), settle };
}
