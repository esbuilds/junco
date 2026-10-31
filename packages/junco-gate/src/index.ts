// junco-gate: an owner's policy in front of any MCP server's tools. Every call is allowed, held for the owner, or
// denied. A held call is stored exactly as asked; approving it runs that call and nothing else, after an optional
// re-check of the world it would act on, and its outcome is tracked (completed, failed, or unknown and then settled by
// a re-read, never by running it twice). Every decision goes to an action log.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Verdict = 'allow' | 'hold' | 'deny';
// read: runs and changes nothing. hidden: not listed, and denied if called anyway. A limit allows a call that moves at
// most max_amount (args.amount, args.amount.value or args.offer_amount.value) and applies `over` above it.
export type Rule = Verdict | 'read' | 'hidden' | { max_amount: number; over: Verdict };
// daily_total: what calls that go out without the owner's approval may add up to in a UTC day, in USD. Past it they hold.
export type Policy = { default: Verdict; tools: Record<string, Rule>; daily_total?: { max: number; over: 'hold' } };
// pending, then rejected or stale (refused at approval), or executing then completed, failed or unknown. expired: a hold
// given an `expires` time that was still pending past it (the store that sets it marks it; it never runs).
// 'approved' only appears on holds stored by older versions.
export type HoldStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'unknown' | 'approved' | 'rejected' | 'stale' | 'expired';
export type Hold = { id: string; method: string; args: any; reason: string; created: string; status: HoldStatus; result?: string;
  case?: any; origin?: string; before?: any; ran?: string; expires?: string }; // ran: when an approved hold started running
export type Store = { read(): Hold[]; write(holds: Hold[]): void };
export type Guard = (method: string, args: any, phase: 'call' | 'decide') => string | null;
// error: for an allowed call, the error the tool returned (logged after the call), so the log never shows a refused call as done.
export type Decision = { at: string; method: string; args: any; verdict: Verdict; reason: string; hold_id?: string; error?: string };

// Today's running total. An offer counts though no money moves until a buyer accepts, so this is what was approved in advance, never money out.
export type DayTotal = { day: string; cents: number; calls: number };
export type TotalStore = { read(): DayTotal | null; write(t: DayTotal): void };
// null: not a money call. value null: a money call with no readable amount.
export type MoneyCall = { value: number | null; currency?: string } | null;

export type GateOptions = {
  store?: Store; // where holds live; default .junco/holds.json
  onHold?: (h: Hold) => void; // tell the owner (a webhook, a desk)
  origin?: string; // tags holds when one store serves several gated servers
  guards?: Guard[]; // refuse before policy ('call') or at approval ('decide'), e.g. "not your case"
  allow?: (method: string, args: any) => string | null; // a reason to allow before policy (a standing approval)
  snapshot?: (h: Hold) => Promise<any>; // state stored with a new hold, e.g. what the owner will be shown
  beforeRun?: (h: Hold) => Promise<{ refuse?: string | null; trail?: any }>; // re-check before an approved hold runs
  landed?: (h: Hold) => Promise<boolean | null>; // after an unknown outcome: did it land? (h.before is the trail)
  unknownErrors?: string[]; // error types in a tool result that mean "may have landed", e.g. a dropped connection
  log?: (d: Decision) => void; // the action log
  totals?: TotalStore; // where policy.daily_total's running total lives; default .junco/daily-total.json
  money?: (method: string, args: any) => MoneyCall | undefined; // what a call counts as; undefined leaves it to amount limits and standing approvals
  refused?: (text: string | undefined) => boolean; // did this failed call definitely not go through? Only then is its daily total released. Default: any error not in unknownErrors
};

export const jsonStore = (path = '.junco/holds.json', onWrite?: (path: string, holds: Hold[]) => void): Store => ({
  read: () => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return []; } },
  write: (h) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(h, null, 2)); onWrite?.(path, h); },
});

export const jsonTotal = (path = '.junco/daily-total.json', onWrite?: (path: string, t: DayTotal) => void): TotalStore => ({
  read: () => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } },
  write: (t) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(t, null, 2)); onWrite?.(path, t); },
});
const utcDay = () => new Date().toISOString().slice(0, 10);
const usd = (cents: number) => (cents / 100).toFixed(2);
export const dayTotal = (t: DayTotal | null): DayTotal => (t?.day === utcDay() ? t : { day: utcDay(), cents: 0, calls: 0 }); // a new UTC day starts at zero

const amountOf = (args: any): number | null => {
  const v = args?.offer_amount?.value ?? args?.amount?.value ?? args?.amount;
  return v == null ? null : Number(v);
};

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

type Handler = (args: any, extra: any) => Promise<any>;
const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });
const errorOf = (t?: string) => { try { return JSON.parse(t ?? '').error; } catch { return undefined; } };

// What a client must know before it calls a tool the gate can hold (Oct 28: a Claude refused to call create_refund, believing
// it would move money on its own). Only what the gate does: a held call runs only after the owner's approval, at most once.
const HOLD_NOTE = 'Through this server, this call does not run when you make it. It creates a hold: the owner sees the exact call and '
  + 'approves or rejects it, and only their approval runs it, at most once. Calling this tool is how you propose the action to the owner.';
const TOTAL_NOTE = (max: number) => ` The owner also set a daily total: calls approved in advance, offers included, may add up to ${max} USD a UTC day. `
  + "A call that would pass it, has no readable amount or isn't in USD creates a hold instead, and an approved hold doesn't count toward it.";
// money: the gate counts this tool toward the daily total. Amount limits always count.
export function policyNote(policy: Policy, name: string, standing: boolean, money = false): string | null {
  const rule = policy.tools[name] ?? policy.default;
  const also = standing ? ' One exception: a standing approval the owner set for this exact case can let it run directly.' : '';
  const total = policy.daily_total && (money || typeof rule === 'object') ? TOTAL_NOTE(policy.daily_total.max) : '';
  if (rule === 'hold') return HOLD_NOTE + also + total;
  if (rule === 'allow' && total) return `Through this server, this call runs directly.${total}`;
  if (typeof rule !== 'object') return null;
  const above = rule.over === 'hold' ? `creates a hold: the owner sees the exact call and approves or rejects it, and only their approval runs it, at most once`
    : rule.over === 'deny' ? 'is refused' : 'runs directly';
  return `Through this server, a call with an amount of at most ${rule.max_amount} (amount.value or offer_amount.value) runs directly; above that, `
    + `or with no readable amount, it ${above}.${rule.over === 'hold' ? ' Calling this tool is how you propose a larger action to the owner.' : ''}${also}${total}`;
}

// server: an McpServer from @modelcontextprotocol/sdk with its tools registered. Call last, so it wraps every tool.
export function gate(server: any, policy: Policy, o: GateOptions = {}) {
  const store = o.store ?? jsonStore();
  const guards = o.guards ?? [];
  const unknown = new Set(o.unknownErrors ?? []);
  const totals = o.totals ?? jsonTotal();
  // What this call counts as toward the daily total: the owner's hook, else an amount limit's amount, else a standing approval's.
  const moneyOf = (name: string, args: any, standing: boolean): MoneyCall => {
    const m = o.money?.(name, args);
    if (m !== undefined) return m;
    const read = { value: amountOf(args), currency: args?.offer_amount?.currency_code ?? args?.amount?.currency_code };
    return typeof policy.tools[name] === 'object' || (standing && read.value !== null) ? read : null;
  };
  // Reserves in the same synchronous step as the check, before anything awaits, so two calls can't both pass the last dollars.
  // ponytail: a read and a write on one file with no await between them is the lock: one gate process (every gate() in it shares
  // the file). A second desk process would need a database lock here.
  const reserve = (name: string, args: any, standing: boolean): { over: string } | { release: () => void } | null => {
    const cap = policy.daily_total, call = cap ? moneyOf(name, args, standing) : null;
    if (!cap || !call) return null;
    const value = Number(call.value);
    if (call.value === null || !Number.isFinite(value) || value < 0) return { over: `${name} counts toward the daily total but has no readable amount` };
    if ((call.currency ?? 'USD') !== 'USD') return { over: `the daily total is in USD and this call is in ${call.currency}` };
    const now = dayTotal(totals.read()), cents = Math.ceil(value * 100 - 1e-6);
    if (!(now.cents + cents <= Math.round(cap.max * 100))) return { over: `the daily total was reached: ${usd(now.cents)} of ${cap.max} USD approved in advance today (UTC), and this ${usd(cents)} would pass it` };
    totals.write({ day: now.day, cents: now.cents + cents, calls: now.calls + 1 });
    return { release: () => { const t = dayTotal(totals.read()); if (t.day === now.day) totals.write({ day: t.day, cents: Math.max(0, t.cents - cents), calls: Math.max(0, t.calls - 1) }); } }; // past midnight, yesterday's total is gone
  };
  const guarded = (method: string, args: any, phase: 'call' | 'decide') => { for (const g of guards) { const why = g(method, args, phase); if (why) return why; } return null; };
  const log = (method: string, args: any, verdict: Verdict, reason: string, hold_id?: string, error?: string) =>
    o.log?.({ at: new Date().toISOString(), method, args, verdict, reason, ...(hold_id && { hold_id }), ...(error && { error }) });

  // ponytail: _registeredTools is private SDK state (checked on @modelcontextprotocol/sdk 1.32); re-check on upgrade
  const tools: Record<string, { handler: Handler; description?: string; update: (u: { callback?: Handler; description?: string }) => void; disable?: () => void }> = server._registeredTools;
  const originals: Record<string, Handler> = {};
  for (const [name, tool] of Object.entries(tools)) {
    originals[name] = tool.handler;
    if (policy.tools[name] === 'hidden') tool.disable?.(); // not listed; a direct call still gets the deny
    // The client reads what the gate does with this tool before it decides to call it. ponytail: written at wrap time; the
    // desk builds a gated server per MCP request, so a policy edit shows on the next connection.
    const note = policyNote(policy, name, !!o.allow, o.money?.(name, {}) !== undefined);
    if (note) tool.update({ description: tool.description ? `${note}\n\n${tool.description}` : note });
    tool.update({
      callback: async (args, extra) => {
        const refused = policy.tools[name] !== 'read' && guarded(name, args, 'call');
        if (refused) { log(name, args, 'deny', refused); return text({ error: { type: 'denied_by_guard', message: `Not allowed: ${refused}` } }); }
        const standing = o.allow?.(name, args);
        let { verdict, reason } = standing ? { verdict: 'allow' as Verdict, reason: standing } : decide(policy, name, args);
        const counted = verdict === 'allow' && policy.tools[name] !== 'read' ? reserve(name, args, !!standing) : null;
        if (counted && 'over' in counted) { verdict = 'hold'; reason = counted.over; } // the ordinary hold below: same owner, same approval
        if (verdict === 'allow') {
          try {
            const r = await originals[name](args, extra);
            const t = r?.content?.[0]?.text, err = errorOf(t) ?? (r?.isError || (() => { try { return JSON.parse(t ?? '').ok === false; } catch { return false; } })() ? t : undefined);
            // Only a definite refusal gives the reservation back; an unknown outcome or a throw (below) may have landed.
            if (err && counted && (o.refused ? o.refused(t) : !unknown.has(err?.type))) (counted as { release: () => void }).release();
            log(name, args, verdict, reason, undefined, err ? (typeof err === 'string' ? err : err.message ?? JSON.stringify(err)).slice(0, 300) : undefined);
            return r;
          } catch (e: any) { log(name, args, verdict, reason, undefined, e.message); throw e; }
        }
        if (verdict === 'deny') { log(name, args, verdict, reason); return text({ error: { type: 'denied_by_policy', message: reason } }); }
        // The same call asked again (an agent retrying, or asking twice) never makes a second hold.
        // ponytail: exact-args match, forever; a call that differs only in a note gets its own hold and the stale re-read catches it.
        const key = JSON.stringify(args);
        const dup = store.read().find((h) => h.method === name && h.origin === o.origin && JSON.stringify(h.args) === key && ['pending', 'executing', 'completed', 'unknown'].includes(h.status));
        if (dup?.status === 'pending' || dup?.status === 'executing') {
          log(name, args, 'hold', `the same call is already held as ${dup.id}`, dup.id);
          return text({ held: true, hold_id: dup.id, duplicate: true, reason: dup.reason, next: `Not held again: this exact call is already waiting for the owner as hold ${dup.id}. Do not call it again.` });
        }
        if (dup) {
          const why = `this exact call already ran as hold ${dup.id} (${dup.status})`;
          log(name, args, 'deny', why);
          return text({ error: { type: 'duplicate_call', message: `Not held: ${why}. Nothing was sent.` } });
        }
        const hold: Hold = { id: randomUUID().slice(0, 8), method: name, args, reason, created: new Date().toISOString(), status: 'pending', ...(o.origin && { origin: o.origin }) };
        if (o.snapshot) hold.case = await o.snapshot(hold).catch(() => undefined);
        store.write([...store.read(), hold]);
        log(name, args, verdict, reason, hold.id);
        o.onHold?.(hold);
        return text({ held: true, hold_id: hold.id, reason, next: 'Not executed. The owner must approve this action. If they approve, this exact call runs once; do not call it again, and tell the user it is waiting for the owner.' });
      },
    });
  }

  // The same fact in the server's MCP instructions, which a client reads once at initialize. ponytail: _instructions is
  // private SDK state (set from the constructor; checked on @modelcontextprotocol/sdk 1.32); re-check on upgrade.
  const inner = server.server;
  if (inner && Object.keys(tools).some((n) => policyNote(policy, n, false)))
    inner._instructions = [inner._instructions, 'Tools that move money or commit the store go through an owner approval gate: their descriptions say which. '
      + 'A held call does not run when you make it; it creates a hold the owner approves or rejects, and only an approval runs it, at most once. '
      + 'Calling such a tool is the way to propose the action to the owner.'
      + (policy.daily_total ? ` Calls approved in advance, offers included, may add up to ${policy.daily_total.max} USD a UTC day; past that they hold too.` : '')].filter(Boolean).join('\n\n');

  async function resolve(id: string, approve: boolean): Promise<Hold> {
    const holds = store.read();
    const h = holds.find((x) => x.id === id);
    if (!h) throw new Error(`No hold ${id}`);
    if (h.status !== 'pending') throw new Error(`Hold ${id} is already ${h.status}`);
    const refused = guarded(h.method, h.args, 'decide');
    if (refused) throw Object.assign(new Error(`Not allowed: ${refused}.`), { code: 403 });
    if (!approve) { h.status = 'rejected'; store.write(holds); return h; }
    // Approval runs only the stored method and args, and only if the world is still the one the owner was shown.
    const pre = o.beforeRun ? await o.beforeRun(h) : {};
    if (pre.refuse) {
      h.status = 'stale'; h.result = JSON.stringify({ error: { type: 'stale_hold', message: `Not run: ${pre.refuse}` } });
      store.write(holds);
      throw Object.assign(new Error(`Not run: ${pre.refuse}. Nothing was sent.`), { code: 400 });
    }
    h.status = 'executing'; h.ran = new Date().toISOString(); if (pre.trail !== undefined) h.before = pre.trail;
    store.write(holds); // mark first so a crash mid-call can't run it twice; a hold left executing settles like unknown
    try {
      const r = await originals[h.method](h.args, {});
      h.result = r.content?.[0]?.text;
      const err = errorOf(h.result);
      h.status = unknown.has(err?.type) ? 'unknown' : err || r.isError ? 'failed' : 'completed';
    } catch (e: any) {
      h.status = 'unknown'; h.result = JSON.stringify({ error: { type: 'outcome_unknown', message: e.message } });
    }
    store.write(holds);
    return h.status === 'unknown' ? settle(id) : h;
  }

  // Settle an unknown (or crashed executing) hold to completed or failed from landed(). Never runs the call again.
  async function settle(id: string): Promise<Hold> {
    const holds = store.read();
    const h = holds.find((x) => x.id === id);
    if (!h) throw new Error(`No hold ${id}`);
    if (h.status !== 'unknown' && h.status !== 'executing') return h;
    const did = o.landed ? await o.landed(h).catch(() => null) : null;
    if (did === null) return h; // nothing to compare: stays unknown, the owner checks by hand
    h.status = did ? 'completed' : 'failed';
    h.result = JSON.stringify({ settled: `a re-read shows the ${h.method} ${did ? 'landed' : 'did not land'}`, was: h.result });
    store.write(holds);
    return h;
  }

  return { approve: (id: string) => resolve(id, true), reject: (id: string) => resolve(id, false), settle, holds: () => store.read() };
}

export { mirror } from './mirror.js';
