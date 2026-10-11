// JUNCO's approval gate: the junco-gate package (packages/junco-gate) with PayPal dispute hooks. Every tool call on the
// MCP server (stock PayPal tools, PayPal's hosted ones and JUNCO's) is allowed, held for the owner, or denied by policy.json.
// What's JUNCO's here: holds snapshot the case the owner is shown and are refused if it moved on; an unknown outcome is
// settled from PayPal's re-read of the case; standing approvals; the desk's guards (case leases); Postgres mirroring.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mirror } from './persist.js';
import { decide as policyDecide, gate as wrap, jsonStore, type Guard, type Hold as PkgHold, type Policy as PkgPolicy, type Verdict } from '../packages/junco-gate/src/index.js';

export type { Verdict, Rule, HoldStatus, Guard } from '../packages/junco-gate/src/index.js';
export type Policy = PkgPolicy & { ship_within_days?: number };
export type CaseState = { stage: string; amount: string };
export type Hold = PkgHold & { case?: CaseState; before?: Trail };

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
const amountOf = (args: any): number | null => { const v = args?.offer_amount?.value ?? args?.amount?.value ?? args?.amount; return v == null ? null : Number(v); };
export const movesMoney = (method: string, args: any, b: Budget): number =>
  method === 'accept_dispute_claim' ? b.amount : amountOf(args) ?? 0;
const standing = (method: string, args: any, budgets = readBudgets()): string | null => {
  const b = args?.dispute_id ? budgets[args.dispute_id] : undefined;
  return b && movesMoney(method, args, b) <= b.limit ? `within the ${b.limit} ${b.currency} standing approval for ${args.dispute_id}` : null;
};
export function decide(policy: Policy, method: string, args: any, budgets: Record<string, Budget> = {}): { verdict: Verdict; reason: string } {
  const s = standing(method, args, budgets);
  return s ? { verdict: 'allow', reason: s } : policyDecide(policy, method, args);
}

// Holds live in one JSON file, mirrored to Postgres when DATABASE_URL is set (persist.ts). One writer process.
const store = jsonStore('.junco/holds.json', mirror);
export const readHolds = (): Hold[] => store.read() as Hold[];

// Ask the owner directly: a pending hold for an action JUNCO wants but won't take on its own (e.g. a negotiation that
// hit its ceiling). Approving it runs the tool through the same path as any other hold.
export function requestApproval(method: string, args: any, reason: string): Hold {
  const hold: Hold = { id: randomUUID().slice(0, 8), method, args, reason, created: new Date().toISOString(), status: 'pending' };
  store.write([...store.read(), hold]);
  return hold;
}

// The desk adds case leases here. ponytail: one process-wide list; pass guards per gate if a process ever runs two desks.
export const guards: Guard[] = [];

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
  if (changed) store.write(holds);
  return changed;
}

// getCase reads a dispute from PayPal; without it, approvals run the stored call with no re-read (offline checks).
// origin tags holds from a server other than the desk's own (PayPal hosted), so approval runs on the same server.
export function gate(server: any, policy: Policy, onHold?: (h: Hold) => void, getCase?: (id: string) => Promise<any>, origin?: string) {
  const read = (h: PkgHold) => (getCase && h.args?.dispute_id ? getCase(h.args.dispute_id) : null);
  return wrap(server, policy, {
    store, guards, origin, onHold: onHold as (h: PkgHold) => void,
    allow: (method, args) => standing(method, args),
    snapshot: async (h) => { const d = await read(h); return d ? caseState(d) : undefined; },
    beforeRun: async (h) => { const d = await read(h); return d ? { refuse: staleReason(h as Hold, d), trail: trail(d) } : {}; },
    landed: async (h) => { const d = h.before ? await read(h)?.catch(() => null) : null; return d ? landed(h.method, h.before, d) : null; },
    unknownErrors: ['hosted_unavailable', 'upstream_unavailable'],
  });
}
