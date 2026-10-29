// JUNCO's approval gate: the junco-gate package (packages/junco-gate) with PayPal dispute hooks. Every tool call on the
// MCP server (stock PayPal tools, PayPal's hosted ones and JUNCO's) is allowed, held for the owner, or denied by policy.json.
// What's JUNCO's here: holds snapshot the case the owner is shown and are refused if it moved on; an unknown outcome is
// settled from PayPal's re-read of the case; standing approvals; the desk's guards (case leases); Postgres mirroring.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mirror } from './persist.js';
import { decide as policyDecide, gate as wrap, jsonStore, type Decision, type Guard, type Hold as PkgHold, type Policy as PkgPolicy, type Verdict } from '../packages/junco-gate/src/index.js';

export type { Verdict, Rule, HoldStatus, Guard } from '../packages/junco-gate/src/index.js';
export type Policy = PkgPolicy & { ship_within_days?: number };
export type { CaseState };
// recheck (S4): PayPal's webhook said the case or payment changed after the hold was made; refund: a refund PayPal
// reported on the same payment after that.
export type Recheck = { at: string; event: string; refund?: { id: string; at: string } };
export type Hold = PkgHold & { case?: CaseState | CaptureState; before?: Trail | CaptureState; recheck?: Recheck };

// The PayPal dispute hooks (snapshot, stale refusal, did-it-land) live in the package, shared with the junco-gate CLI.
import { staleReason, landed, paypalDisputeHooks, type CaseState, type CaptureState, type Trail } from '../packages/junco-gate/src/paypal.js';
export { staleReason, landed, type Trail };

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
// Expiry, lazily on read: a hold with `expires` (only a visitor's support-agent refund ask sets one, refund-ask.ts) still
// pending past it becomes 'expired' the next time anything reads holds, so it never runs: the package approves only
// pending holds, and the desk, the one-tap link and the gate all read through this store. Other holds never expire.
const file = jsonStore('.junco/holds.json', mirror);
export const EXPIRED_TEXT = "The owner didn't decide within 24 hours, so nothing moved.";
const lapse = (holds: Hold[]) => {
  const now = new Date().toISOString(), due = holds.filter((h) => h.status === 'pending' && h.expires && h.expires <= now);
  for (const h of due) { h.status = 'expired'; h.result = JSON.stringify({ settled: `expired at ${h.expires}. ${EXPIRED_TEXT}` }); }
  if (due.length) file.write(holds);
  return holds;
};
const store = { read: () => lapse(file.read() as Hold[]), write: file.write };
export const readHolds = (): Hold[] => store.read();
export const HOLD_TTL_MS = 24 * 3600_000;
// Gives a hold its 24 hours. Only on a pending hold that has none yet: an identical call made by someone else and joined
// by the gate keeps its own terms.
export function setExpiry(id: string, from = Date.now()) {
  const holds = file.read() as Hold[], h = holds.find((x) => x.id === id);
  if (!h || h.status !== 'pending' || h.expires) return null;
  h.expires = new Date(Math.max(from, Date.parse(h.created)) + HOLD_TTL_MS).toISOString();
  file.write(holds);
  return h.expires;
}

// The Gate record (v3.14 item 1): every money move proposed to the gate, from every source, with its verdict and what
// became of it. Read from the hold store, the challenge runs and this log of the gate's own money decisions; nothing
// from the model. Holds already carry every held move, so the log keeps only allowed and denied ones.
export const MONEY = ['make_dispute_offer', 'accept_dispute_claim', 'create_refund'];
const MOVES = '.junco/gate-log.json';
export type Move = Decision & { source: string };
export const readMoves = (): Move[] => { try { return JSON.parse(readFileSync(MOVES, 'utf8')); } catch { return []; } };
export const logMove = (source: string) => (d: Decision) => {
  if (!MONEY.includes(d.method) || d.verdict === 'hold') return;
  const all = [...readMoves(), { ...d, source }].slice(-2000);
  mkdirSync('.junco', { recursive: true }); writeFileSync(MOVES, JSON.stringify(all, null, 2)); mirror(MOVES, all);
};

export type RecordRow = { at: string; source: string; dispute_id: string | null; method: string; amount: string | null;
  verdict: Verdict | 'gate-only'; outcome: string; hold_id?: string; run_id?: string; reason: string };
const OUTCOME: Record<string, string> = { pending: 'held, waiting for the owner', executing: 'approved by the owner, running',
  completed: 'approved by the owner, PayPal accepted it', approved: 'approved by the owner (outcome not recorded)',
  failed: 'approved by the owner, PayPal refused it', unknown: 'approved by the owner, outcome unknown (re-check PayPal)',
  rejected: 'rejected by the owner, nothing sent', stale: 'stale: the case moved on, nothing sent',
  expired: "expired: the owner didn't decide within 24 hours, nothing sent" };
const amountText = (args: any, h?: Hold) => { const a = args?.offer_amount ?? args?.amount; return a?.value ? `${a.value} ${a.currency_code ?? ''}`.trim() : (h?.case as CaseState | undefined)?.amount ?? null; };
// Why a stale hold was refused, from its stored result ("Not run: <why>").
const staleWhy = (h: Hold) => { try { return JSON.parse(h.result ?? '').error.message.replace(/^Not run: /, ''); } catch { return 'refused at approval'; } };
// runs: Break the mandate records (challenge.ts). A run whose move made a real hold is that hold's row; any other money
// run is its own row (the run record names the source), and the log entry it left on the desk's server is skipped.
export function gateRecord(holds: Hold[], runs: any[], moves: Move[], tagOf: (h: Hold) => string | undefined): RecordRow[] {
  const rows: RecordRow[] = holds.filter((h) => MONEY.includes(h.method)).map((h) => ({
    at: h.created, source: tagOf(h) ?? 'unknown', dispute_id: h.args?.dispute_id ?? null, method: h.method, amount: amountText(h.args, h),
    verdict: 'hold', outcome: h.status === 'stale' && h.method === 'create_refund' ? `stale: ${staleWhy(h)}, nothing sent` : OUTCOME[h.status] ?? h.status, hold_id: h.id, reason: h.reason }));
  const money = runs.filter((r) => r.proposed && MONEY.includes(r.proposed.method) && !r.gate.hold_id);
  const fromRun = (m: Move) => money.some((r) => r.dispute_id === m.args?.dispute_id && r.proposed.method === m.method && Math.abs(Date.parse(r.at) - Date.parse(m.at)) < 120_000);
  for (const m of moves) if (!fromRun(m)) rows.push({ at: m.at, source: m.source, dispute_id: m.args?.dispute_id ?? null, method: m.method, amount: amountText(m.args),
    verdict: m.verdict, outcome: m.verdict === 'deny' ? 'denied, nothing sent' : m.error ? `allowed, PayPal refused it: ${m.error.slice(0, 120)}` : 'allowed by policy, PayPal accepted it', reason: m.reason });
  for (const r of money) rows.push({
    at: r.at, source: r.via === 'red team' ? 'red team (automated)' : r.via === 'mcp' ? 'Break the mandate via MCP' : 'Break the mandate', dispute_id: r.dispute_id,
    method: r.proposed.method, amount: amountText(r.proposed.args), verdict: r.gate_only ? 'gate-only' : r.gate.verdict, run_id: r.id, reason: r.gate.reason,
    outcome: r.gate_only ? `gate-only run: the gate would ${r.gate.verdict === 'allow' ? 'allow' : r.gate.verdict} it; no hold made, nothing sent` : `${r.gate.verdict}; PayPal: ${r.paypal.result}` });
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

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
// getCapture reads a payment, so a held refund is refused if the payment changed (refunded already) since it was held.
// origin tags holds from a server other than the desk's own (PayPal hosted), so approval runs on the same server.
// log: the action log (every allow, hold and deny); the desk records MCP clients' allowed writes from it.
export function gate(server: any, policy: Policy, onHold?: (h: Hold) => void, getCase?: (id: string) => Promise<any>, origin?: string, log?: (d: Decision) => void, getCapture?: (id: string) => Promise<any>) {
  const hooks = paypalDisputeHooks(getCase ?? (async () => null), getCapture, readHolds);
  return wrap(server, policy, {
    store, guards, origin, log, onHold: onHold as (h: PkgHold) => void,
    allow: (method, args) => standing(method, args),
    ...hooks,
    // The one-refund rule's second witness: a refund PayPal itself reported on this payment after the hold was made.
    beforeRun: async (h) => {
      const r = (h as Hold).recheck?.refund;
      return h.method === 'create_refund' && r ? { refuse: `PayPal reported refund ${r.id} on payment ${h.args.capture_id} after this was held` } : hooks.beforeRun!(h);
    },
  });
}

// S4: a PayPal webhook touched the case or payment of pending holds. Holds made before the change are flagged
// "re-check" (the owner sees it before tapping); approval still re-reads PayPal as the backstop. Returns the flagged.
export function flagHolds(on: { dispute_id?: string; capture_id?: string }, event: string, changedAt: string, refund?: { id: string; at: string }): Hold[] {
  const holds = readHolds(), when = Date.parse(changedAt) || Date.now();
  const hit = holds.filter((h) => h.status === 'pending' && Date.parse(h.created) < when
    && ((!!on.dispute_id && h.args?.dispute_id === on.dispute_id) || (!!on.capture_id && h.args?.capture_id === on.capture_id)));
  for (const h of hit) {
    const after = refund && Date.parse(refund.at) > Date.parse(h.created) ? refund : h.recheck?.refund;
    h.recheck = { at: new Date(when).toISOString(), event, ...(after && { refund: after }) };
  }
  if (hit.length) store.write(holds);
  return hit;
}
