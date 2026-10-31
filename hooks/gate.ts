// JUNCO's gate as a Claude Code hook: the owner's policy.json in front of PayPal's own plugin (paypal/AI-Toolkit, MCP server
// `paypal-sandbox`) or any MCP server named `paypal`, inside the editor. Every hook run is its own process, so the state is
// files in the project (.junco/holds.json, .junco/daily-total.json, .junco/gate-log.jsonl), the same files the junco-gate
// command reads, and the total and the holds are written under a cross-process lock.
//   PreToolUse: a read, or an allowed write within its limit and the daily total, gets no decision from this hook, so Claude
//   Code's own permission prompt still applies and the call goes to PayPal's server as it would without JUNCO. A held call
//   is stored exactly as asked and refused with its hold id; nothing reaches PayPal until the owner runs
//   `junco-gate approve <id>`. A call the policy denies is refused. The same call asked again never makes a second hold.
//   PostToolUse: an allowed call that PayPal definitely refused (a 4xx) gives its daily-total reservation back.
//   On Bash, Write, Edit, MultiEdit and NotebookEdit: the plain routes around the gate are refused (running `junco-gate approve`,
//   changing policy.json or .junco/). See guardRoutes for what that is and isn't.
// Dependency-free on purpose: the plugin cache has no node_modules, so `npm run build:plugin` bundles this file into
// hooks/gate.mjs, which is what hooks/hooks.json runs. check-plugin fails if the bundle is stale.
// What fails closed and what fails open. Everything inside main() fails closed: hook input that isn't JSON, a missing or
// unreadable policy, a thrown error, each ends in a deny. Two paths fail open, because Claude Code treats a hook's non-2 exit
// and a timed-out hook as non-blocking: a crash before main() runs (a broken bundle; check-plugin rebuilds and runs it), and
// a run past the 20 s timeout in hooks.json (this hook waits at most 3 s for the lock and 3 s for Slack).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { amountOf, dayTotal, decide, usd, type DayTotal, type Policy } from '../packages/junco-gate/src/policy.js';
import { definiteRefusal } from '../packages/junco-gate/src/paypal.js';

type Input = { hook_event_name?: string; tool_name?: string; tool_input?: any; tool_response?: any; tool_use_id?: string; cwd?: string; session_id?: string };
type Total = DayTotal & { open?: Record<string, number> }; // open: this hook's reservations by tool_use_id, given back on a definite refusal
type Hold = { id: string; method: string; args: any; reason: string; created: string; status: string; origin: string; tool: string; session?: string };
const ORIGIN = 'claude-code-plugin';

const readJson = <T>(p: string, fallback: T): T => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p: string, v: unknown) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); };

// A lock across processes: mkdir is atomic everywhere Node runs, so the read-and-write of a file happens under it. A lock older
// than 5 s belongs to a hook that crashed and is taken over; a hook that can't get the lock in 3 s fails rather than guesses.
function locked<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const until = Date.now() + 3000;
  for (;;) {
    try { mkdirSync(lock); break; } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 5000) { rmdirSync(lock); continue; } } catch {}
      if (Date.now() > until) throw new Error(`the gate's files are locked by another hook (${lock})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try { return fn(); } finally { try { rmdirSync(lock); } catch {} }
}

const refuse = (reason: string) =>
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));

const heldText = (h: Hold, cwd: string, again: boolean) =>
  `JUNCO held this call${again ? ' (it was already held)' : ''}: ${h.reason}. Hold ${h.id}: ${h.method} ${JSON.stringify(h.args).slice(0, 160)}. `
  + `Nothing was sent to PayPal. The owner, at their own terminal, runs exactly this call with: junco-gate approve ${h.id} --toolkit (in ${cwd}), or rejects it with: junco-gate reject ${h.id}. `
  + 'You cannot approve it: that command only runs for a person at a terminal, and this plugin refuses it, and any change to policy.json or .junco/, from this session. '
  + 'Do not call this tool again for the same action. Tell the user the hold id and that it is waiting for the owner.';

// The plain routes around the gate, refused from the editor: running the approve command, or changing policy.json or the
// .junco/ records. A string match is a speed bump, not a boundary. The real line is that `junco-gate approve` refuses without
// a person at a terminal, and a script the agent writes could still try anything this user can do with the token. Claude
// Code's own permission prompt for Bash and file writes still applies after this hook says nothing.
function guardRoutes(name: string, input: Input) {
  const i = input.tool_input ?? {};
  if (name === 'Bash') {
    const cmd = String(i.command ?? '');
    if (/\bjunco-gate\b[^\n;&|]*\bapprove\b/.test(cmd)) return refuse("Not run: approving a JUNCO hold is the owner's, typed at their terminal. Tell the user the hold id instead.");
    const touches = /(^|[\s/'"=])(\.junco(\/|\b)|policy\.json)/.test(cmd), readOnly = /^\s*(cat|ls|head|tail|jq|grep|wc|stat|junco-gate\s+holds)\b[^>|<`$]*$/.test(cmd);
    if (touches && !readOnly) return refuse("Not run: policy.json and the .junco/ records are the owner's, and this command could change them. Reading them with cat, ls, head, tail, jq or grep is fine.");
    return;
  }
  const path = String(i.file_path ?? i.notebook_path ?? i.path ?? '');
  if (/(^|\/)policy\.json$/.test(path) || /(^|\/)\.junco(\/|$)/.test(path)) return refuse(`Not written: ${path} is the owner's (JUNCO's policy or records). Tell the user what you wanted to change.`);
}

async function notify(h: Hold, cwd: string) {
  const url = process.env.HOLD_WEBHOOK_URL;
  if (!url) return;
  const text = `JUNCO is holding *${h.method}* ${JSON.stringify(h.args).slice(0, 200)} from Claude Code in ${cwd}.\nWhy: ${h.reason}\nApprove with: junco-gate approve ${h.id} --toolkit`;
  try { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(3000) }); }
  catch (e: any) { console.error(`[junco] webhook: ${e.message}`); }
}

async function main() {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let input: Input;
  try { input = JSON.parse(raw); if (!input || typeof input !== 'object') throw new Error('not an object'); }
  catch { refuse('JUNCO could not read this tool call (the hook input was not JSON), so it was not sent.'); return; } // fail closed
  const name = input.tool_name ?? '';
  if (!name.startsWith('mcp__')) { if (input.hook_event_name === 'PreToolUse') guardRoutes(name, input); return; }
  const method = name.slice(name.lastIndexOf('__') + 2);
  if (!method) { if (input.hook_event_name === 'PreToolUse') refuse(`JUNCO could not name the tool in ${name}, so it was not sent.`); return; }
  const cwd = input.cwd || process.cwd();
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const policyPath = [join(cwd, 'policy.json'), root ? join(root, 'policy.json') : ''].find((p) => p && existsSync(p));
  const paths = { holds: join(cwd, '.junco/holds.json'), total: join(cwd, '.junco/daily-total.json'), log: join(cwd, '.junco/gate-log.jsonl') };
  const log = (verdict: string, reason: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(dirname(paths.log), { recursive: true });
    appendFileSync(paths.log, JSON.stringify({ at: new Date().toISOString(), method, args: input.tool_input, verdict, reason, origin: ORIGIN, tool: name, policy: policyPath, ...extra }) + '\n');
  };
  if (!policyPath) {
    if (input.hook_event_name === 'PreToolUse') { log('deny', 'no policy.json'); refuse('JUNCO found no policy.json in this folder or in the plugin, so nothing goes to PayPal from here. Add one (the repo has the default) and ask again.'); }
    return;
  }
  const policy = readJson<Policy | null>(policyPath, null);
  if (!policy?.tools) { if (input.hook_event_name === 'PreToolUse') { log('deny', `unreadable policy ${policyPath}`); refuse(`JUNCO could not read ${policyPath}, so nothing goes to PayPal from here.`); } return; }

  if (input.hook_event_name === 'PostToolUse') { // an allowed call PayPal definitely refused gives its reservation back
    const id = input.tool_use_id;
    if (!id) return;
    const r = input.tool_response;
    const text: string = typeof r === 'string' ? r : typeof r?.content?.[0]?.text === 'string' ? r.content[0].text : JSON.stringify(r ?? '');
    const body = readJsonText<any>(text);
    const failed = r?.isError === true || body?.ok === false || body?.error !== undefined;
    if (!failed || !definiteRefusal(text)) return; // an outcome that may have landed keeps its reservation
    locked(paths.total, () => {
      const t = dayTotal(readJson<Total | null>(paths.total, null)) as Total;
      const cents = t.open?.[id];
      if (cents == null) return;
      const open = { ...t.open }; delete open[id];
      writeJson(paths.total, { day: t.day, cents: Math.max(0, t.cents - cents), calls: Math.max(0, t.calls - 1), open });
      log('release', `PayPal refused the allowed ${method}; its ${usd(cents)} reservation is given back`, { tool_use_id: id });
    });
    return;
  }
  if (input.hook_event_name !== 'PreToolUse') return;

  const args = input.tool_input ?? {};
  const rule = policy.tools[method];
  let { verdict, reason } = decide(policy, method, args);
  if (rule === 'read') { log('allow', reason); return; } // reads never count and get no decision from here
  if (verdict === 'allow') {
    // The daily total counts tools with an amount limit, as the package does. The check and the reservation happen under the
    // lock, before the call, so two hooks can't both pass the last dollars. An approved hold never counts.
    const cap = policy.daily_total;
    if (cap && typeof rule === 'object') {
      const value = amountOf(args), currency = args?.offer_amount?.currency_code ?? args?.amount?.currency_code ?? 'USD';
      const over = value === null || !Number.isFinite(value) || value < 0 ? `${method} counts toward the daily total but has no readable amount`
        : currency !== 'USD' ? `the daily total is in USD and this call is in ${currency}`
        : locked(paths.total, (): string | null => {
          const t = dayTotal(readJson<Total | null>(paths.total, null)) as Total, cents = Math.ceil(value * 100 - 1e-6);
          if (t.cents + cents > Math.round(cap.max * 100)) return `the daily total was reached: ${usd(t.cents)} of ${cap.max} USD approved in advance today (UTC), and this ${usd(cents)} would pass it`;
          writeJson(paths.total, { day: t.day, cents: t.cents + cents, calls: t.calls + 1, open: { ...t.open, ...(input.tool_use_id && { [input.tool_use_id]: cents }) } });
          return null;
        });
      if (over) { verdict = 'hold'; reason = over; }
    }
    if (verdict === 'allow') { log('allow', reason); return; } // Claude Code's own permission prompt still applies; PayPal's answer is PayPal's
  }
  if (verdict === 'deny') { log('deny', reason); refuse(`Not allowed by the owner's policy: ${reason}. Nothing was sent to PayPal.`); return; }

  // hold: stored exactly as asked, once
  const key = JSON.stringify(args);
  const outcome = locked(paths.holds, (): { hold: Hold; again: boolean } | { ran: Hold } => {
    const holds = readJson<Hold[]>(paths.holds, []);
    const dup = holds.find((h) => h.method === method && h.origin === ORIGIN && JSON.stringify(h.args) === key && ['pending', 'executing', 'completed', 'unknown'].includes(h.status));
    if (dup?.status === 'pending' || dup?.status === 'executing') return { hold: dup, again: true };
    if (dup) return { ran: dup };
    const hold: Hold = { id: randomUUID().slice(0, 8), method, args, reason, created: new Date().toISOString(), status: 'pending', origin: ORIGIN, tool: name, ...(input.session_id && { session: input.session_id }) };
    writeJson(paths.holds, [...holds, hold]);
    return { hold, again: false };
  });
  if ('ran' in outcome) {
    const why = `this exact call already ran as hold ${outcome.ran.id} (${outcome.ran.status})`;
    log('deny', why); refuse(`Not held: ${why}. Nothing was sent.`); return;
  }
  log('hold', outcome.again ? `the same call is already held as ${outcome.hold.id}` : reason, { hold_id: outcome.hold.id });
  if (!outcome.again) await notify(outcome.hold, cwd);
  refuse(heldText(outcome.hold, cwd, outcome.again));
}

function readJsonText<T = any>(s: string): T { try { return JSON.parse(s); } catch { return {} as T; } }

// Anything thrown ends in a deny (fail closed), written as JSON so Claude Code reads it as a decision rather than an error.
main().catch((e) => { console.error(`[junco] ${e.message}`); refuse(`JUNCO's gate failed (${e.message}), so this call was not sent to PayPal.`); process.exit(0); });
