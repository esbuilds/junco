// Approval gate: every tool call on the MCP server (stock PayPal tools and JUNCO's) is allowed, held for the owner, or denied by policy.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mirror } from './persist.js';

export type Verdict = 'allow' | 'hold' | 'deny';
export type Rule = Verdict | { max_amount: number; over: Verdict };
export type Policy = { default: Verdict; tools: Record<string, Rule>; ship_within_days?: number };
export type Hold = { id: string; method: string; args: any; reason: string; created: string; status: 'pending' | 'approved' | 'rejected'; result?: string };

export const loadPolicy = (path = 'policy.json'): Policy => JSON.parse(readFileSync(path, 'utf8'));

// Owner edits from the desk live in .junco/policy.json (mirrored to Postgres); policy.json in the repo stays the default.
const SAVED_POLICY = '.junco/policy.json';
export const loadActivePolicy = (): Policy => { try { return loadPolicy(SAVED_POLICY); } catch { return loadPolicy(); } };
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

type Handler = (args: any, extra: any) => Promise<any>;
const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });

export function gate(server: any, policy: Policy, onHold?: (h: Hold) => void) {
  // ponytail: _registeredTools is private SDK state (checked on @modelcontextprotocol/sdk 1.32); re-check on upgrade
  const tools: Record<string, { handler: Handler; update: (u: { callback: Handler }) => void }> = server._registeredTools;
  const originals: Record<string, Handler> = {};
  for (const [name, tool] of Object.entries(tools)) {
    originals[name] = tool.handler;
    tool.update({
      callback: async (args, extra) => {
        const { verdict, reason } = decide(policy, name, args, readBudgets());
        if (verdict === 'allow') return originals[name](args, extra);
        if (verdict === 'deny') return text({ error: { type: 'denied_by_policy', message: reason } });
        const hold: Hold = { id: randomUUID().slice(0, 8), method: name, args, reason, created: new Date().toISOString(), status: 'pending' };
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
    h.status = approve ? 'approved' : 'rejected';
    writeHolds(holds); // mark first so a crash mid-call can't run it twice
    if (approve) {
      const r = await originals[h.method](h.args, {});
      h.result = r.content?.[0]?.text;
      writeHolds(holds);
    }
    return h;
  }
  return { approve: (id: string) => resolve(id, true), reject: (id: string) => resolve(id, false) };
}
