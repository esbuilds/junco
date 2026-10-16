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
export type Policy = { default: Verdict; tools: Record<string, Rule> };
// pending, then rejected or stale (refused at approval), or executing then completed, failed or unknown.
// 'approved' only appears on holds stored by older versions.
export type HoldStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'unknown' | 'approved' | 'rejected' | 'stale';
export type Hold = { id: string; method: string; args: any; reason: string; created: string; status: HoldStatus; result?: string;
  case?: any; origin?: string; before?: any; ran?: string }; // ran: when an approved hold started running
export type Store = { read(): Hold[]; write(holds: Hold[]): void };
export type Guard = (method: string, args: any, phase: 'call' | 'decide') => string | null;
// error: for an allowed call, the error the tool returned (logged after the call), so the log never shows a refused call as done.
export type Decision = { at: string; method: string; args: any; verdict: Verdict; reason: string; hold_id?: string; error?: string };

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
};

export const jsonStore = (path = '.junco/holds.json', onWrite?: (path: string, holds: Hold[]) => void): Store => ({
  read: () => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return []; } },
  write: (h) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(h, null, 2)); onWrite?.(path, h); },
});

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

// server: an McpServer from @modelcontextprotocol/sdk with its tools registered. Call last, so it wraps every tool.
export function gate(server: any, policy: Policy, o: GateOptions = {}) {
  const store = o.store ?? jsonStore();
  const guards = o.guards ?? [];
  const unknown = new Set(o.unknownErrors ?? []);
  const guarded = (method: string, args: any, phase: 'call' | 'decide') => { for (const g of guards) { const why = g(method, args, phase); if (why) return why; } return null; };
  const log = (method: string, args: any, verdict: Verdict, reason: string, hold_id?: string, error?: string) =>
    o.log?.({ at: new Date().toISOString(), method, args, verdict, reason, ...(hold_id && { hold_id }), ...(error && { error }) });

  // ponytail: _registeredTools is private SDK state (checked on @modelcontextprotocol/sdk 1.32); re-check on upgrade
  const tools: Record<string, { handler: Handler; update: (u: { callback: Handler }) => void; disable?: () => void }> = server._registeredTools;
  const originals: Record<string, Handler> = {};
  for (const [name, tool] of Object.entries(tools)) {
    originals[name] = tool.handler;
    if (policy.tools[name] === 'hidden') tool.disable?.(); // not listed; a direct call still gets the deny
    tool.update({
      callback: async (args, extra) => {
        const refused = policy.tools[name] !== 'read' && guarded(name, args, 'call');
        if (refused) { log(name, args, 'deny', refused); return text({ error: { type: 'denied_by_guard', message: `Not allowed: ${refused}` } }); }
        const standing = o.allow?.(name, args);
        const { verdict, reason } = standing ? { verdict: 'allow' as const, reason: standing } : decide(policy, name, args);
        if (verdict === 'allow') {
          try {
            const r = await originals[name](args, extra);
            const t = r?.content?.[0]?.text, err = errorOf(t) ?? (r?.isError || (() => { try { return JSON.parse(t ?? '').ok === false; } catch { return false; } })() ? t : undefined);
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
