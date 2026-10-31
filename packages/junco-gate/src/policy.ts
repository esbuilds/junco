// The policy half of junco-gate, with nothing but Node built-ins: the rule shapes, decide(), the amount a call carries and
// the UTC day's total. The Claude Code plugin's hook (hooks/gate.ts) is bundled from this file alone, so it must never
// import the MCP SDK or anything else from node_modules.

export type Verdict = 'allow' | 'hold' | 'deny';
// read: runs and changes nothing. hidden: not listed, and denied if called anyway. A limit allows a call that moves at
// most max_amount (args.amount, args.amount.value or args.offer_amount.value) and applies `over` above it.
export type Rule = Verdict | 'read' | 'hidden' | { max_amount: number; over: Verdict };
// daily_total: what calls that go out without the owner's approval may add up to in a UTC day, in USD. Past it they hold.
export type Policy = { default: Verdict; tools: Record<string, Rule>; daily_total?: { max: number; over: 'hold' } };

// Today's running total. An offer counts though no money moves until a buyer accepts, so this is what was approved in advance, never money out.
export type DayTotal = { day: string; cents: number; calls: number };
export type TotalStore = { read(): DayTotal | null; write(t: DayTotal): void };
// null: not a money call. value null: a money call with no readable amount.
export type MoneyCall = { value: number | null; currency?: string } | null;

export const utcDay = () => new Date().toISOString().slice(0, 10);
export const usd = (cents: number) => (cents / 100).toFixed(2);
export const dayTotal = (t: DayTotal | null): DayTotal => (t?.day === utcDay() ? t : { day: utcDay(), cents: 0, calls: 0 }); // a new UTC day starts at zero

export const amountOf = (args: any): number | null => {
  const v = args?.offer_amount?.value ?? args?.amount?.value ?? args?.amount;
  return v == null ? null : Number(v);
};

// The policy file a hold was made under, from the gate log: the plugin's hook falls back to its own when the folder has none, so a
// plain `policy.json` in the folder isn't always there at approval.
export const heldPolicy = (log: string, holdId: string): string | undefined => log.split('\n')
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((l) => l?.hold_id === holdId && typeof l.policy === 'string').at(-1)?.policy;

export function decide(policy: Policy, method: string, args: any): { verdict: Verdict; reason: string } {
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
