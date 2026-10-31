// hooks/gate.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// packages/junco-gate/src/policy.ts
var utcDay = () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
var usd = (cents) => (cents / 100).toFixed(2);
var dayTotal = (t) => t?.day === utcDay() ? t : { day: utcDay(), cents: 0, calls: 0 };
var amountOf = (args) => {
  const v = args?.offer_amount?.value ?? args?.amount?.value ?? args?.amount;
  return v == null ? null : Number(v);
};
function decide(policy, method, args) {
  const rule = policy.tools[method];
  if (rule === void 0) return { verdict: policy.default, reason: `${method} not in policy, default ${policy.default}` };
  if (rule === "read") return { verdict: "allow", reason: `policy: ${method} only reads` };
  if (rule === "hidden") return { verdict: "deny", reason: `policy: ${method} is not exposed` };
  if (typeof rule === "string") return { verdict: rule, reason: `policy: ${method} = ${rule}` };
  const amt = amountOf(args);
  if (amt === null || Number.isNaN(amt)) return { verdict: "hold", reason: `${method} has an amount limit but no readable amount` };
  return amt <= rule.max_amount ? { verdict: "allow", reason: `${amt} is within the ${rule.max_amount} limit for ${method}` } : { verdict: rule.over, reason: `${amt} is over the ${rule.max_amount} limit for ${method}` };
}

// packages/junco-gate/src/paypal.ts
function definiteRefusal(text) {
  let b;
  try {
    b = JSON.parse(text ?? "");
  } catch {
    return false;
  }
  if (["invalid_arguments", "action_not_allowed"].includes(b?.error?.type)) return true;
  const status = b?.ok === false ? Number(b.status) : Number(String(b?.error?.message).match(/^(?:PayPal |Could not load dispute \()(\d{3})\)?$/)?.[1]);
  return status >= 400 && status < 500;
}

// hooks/gate.ts
var ORIGIN = "claude-code-plugin";
var readJson = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};
var writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2));
};
function locked(path, fn) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const until = Date.now() + 3e3;
  for (; ; ) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5e3) {
          rmdirSync(lock);
          continue;
        }
      } catch {
      }
      if (Date.now() > until) throw new Error(`the gate's files are locked by another hook (${lock})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
    }
  }
}
var refuse = (reason) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
var heldText = (h, cwd, again) => `JUNCO held this call${again ? " (it was already held)" : ""}: ${h.reason}. Hold ${h.id}: ${h.method} ${JSON.stringify(h.args).slice(0, 160)}. Nothing was sent to PayPal. The owner runs exactly this call with: junco-gate approve ${h.id} --toolkit (in ${cwd}), or rejects it with: junco-gate reject ${h.id}. Do not call this tool again for the same action. Tell the user the hold id and that it is waiting for the owner.`;
async function notify(h, cwd) {
  const url = process.env.HOLD_WEBHOOK_URL;
  if (!url) return;
  const text = `JUNCO is holding *${h.method}* ${JSON.stringify(h.args).slice(0, 200)} from Claude Code in ${cwd}.
Why: ${h.reason}
Approve with: junco-gate approve ${h.id} --toolkit`;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(3e3) });
  } catch (e) {
    console.error(`[junco] webhook: ${e.message}`);
  }
}
async function main() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  const input = readJsonText(raw);
  const name = input.tool_name ?? "";
  const method = name.slice(name.lastIndexOf("__") + 2);
  if (!name.startsWith("mcp__") || !method) return;
  const cwd = input.cwd || process.cwd();
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const policyPath = [join(cwd, "policy.json"), root ? join(root, "policy.json") : ""].find((p) => p && existsSync(p));
  const paths = { holds: join(cwd, ".junco/holds.json"), total: join(cwd, ".junco/daily-total.json"), log: join(cwd, ".junco/gate-log.jsonl") };
  const log = (verdict2, reason2, extra = {}) => {
    mkdirSync(dirname(paths.log), { recursive: true });
    appendFileSync(paths.log, JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), method, args: input.tool_input, verdict: verdict2, reason: reason2, origin: ORIGIN, tool: name, policy: policyPath, ...extra }) + "\n");
  };
  if (!policyPath) {
    if (input.hook_event_name === "PreToolUse") {
      log("deny", "no policy.json");
      refuse("JUNCO found no policy.json in this folder or in the plugin, so nothing goes to PayPal from here. Add one (the repo has the default) and ask again.");
    }
    return;
  }
  const policy = readJson(policyPath, null);
  if (!policy?.tools) {
    if (input.hook_event_name === "PreToolUse") {
      log("deny", `unreadable policy ${policyPath}`);
      refuse(`JUNCO could not read ${policyPath}, so nothing goes to PayPal from here.`);
    }
    return;
  }
  if (input.hook_event_name === "PostToolUse") {
    const id = input.tool_use_id;
    if (!id) return;
    const r = input.tool_response;
    const text = typeof r === "string" ? r : typeof r?.content?.[0]?.text === "string" ? r.content[0].text : JSON.stringify(r ?? "");
    const body = readJsonText(text);
    const failed = r?.isError === true || body?.ok === false || body?.error !== void 0;
    if (!failed || !definiteRefusal(text)) return;
    locked(paths.total, () => {
      const t = dayTotal(readJson(paths.total, null));
      const cents = t.open?.[id];
      if (cents == null) return;
      const open = { ...t.open };
      delete open[id];
      writeJson(paths.total, { day: t.day, cents: Math.max(0, t.cents - cents), calls: Math.max(0, t.calls - 1), open });
      log("release", `PayPal refused the allowed ${method}; its ${usd(cents)} reservation is given back`, { tool_use_id: id });
    });
    return;
  }
  if (input.hook_event_name !== "PreToolUse") return;
  const args = input.tool_input ?? {};
  const rule = policy.tools[method];
  let { verdict, reason } = decide(policy, method, args);
  if (rule === "read") {
    log("allow", reason);
    return;
  }
  if (verdict === "allow") {
    const cap = policy.daily_total;
    if (cap && typeof rule === "object") {
      const value = amountOf(args), currency = args?.offer_amount?.currency_code ?? args?.amount?.currency_code ?? "USD";
      const over = value === null || !Number.isFinite(value) || value < 0 ? `${method} counts toward the daily total but has no readable amount` : currency !== "USD" ? `the daily total is in USD and this call is in ${currency}` : locked(paths.total, () => {
        const t = dayTotal(readJson(paths.total, null)), cents = Math.ceil(value * 100 - 1e-6);
        if (t.cents + cents > Math.round(cap.max * 100)) return `the daily total was reached: ${usd(t.cents)} of ${cap.max} USD approved in advance today (UTC), and this ${usd(cents)} would pass it`;
        writeJson(paths.total, { day: t.day, cents: t.cents + cents, calls: t.calls + 1, open: { ...t.open, ...input.tool_use_id && { [input.tool_use_id]: cents } } });
        return null;
      });
      if (over) {
        verdict = "hold";
        reason = over;
      }
    }
    if (verdict === "allow") {
      log("allow", reason);
      return;
    }
  }
  if (verdict === "deny") {
    log("deny", reason);
    refuse(`Not allowed by the owner's policy: ${reason}. Nothing was sent to PayPal.`);
    return;
  }
  const key = JSON.stringify(args);
  const outcome = locked(paths.holds, () => {
    const holds = readJson(paths.holds, []);
    const dup = holds.find((h) => h.method === method && h.origin === ORIGIN && JSON.stringify(h.args) === key && ["pending", "executing", "completed", "unknown"].includes(h.status));
    if (dup?.status === "pending" || dup?.status === "executing") return { hold: dup, again: true };
    if (dup) return { ran: dup };
    const hold = { id: randomUUID().slice(0, 8), method, args, reason, created: (/* @__PURE__ */ new Date()).toISOString(), status: "pending", origin: ORIGIN, tool: name, ...input.session_id && { session: input.session_id } };
    writeJson(paths.holds, [...holds, hold]);
    return { hold, again: false };
  });
  if ("ran" in outcome) {
    const why = `this exact call already ran as hold ${outcome.ran.id} (${outcome.ran.status})`;
    log("deny", why);
    refuse(`Not held: ${why}. Nothing was sent.`);
    return;
  }
  log("hold", outcome.again ? `the same call is already held as ${outcome.hold.id}` : reason, { hold_id: outcome.hold.id });
  if (!outcome.again) await notify(outcome.hold, cwd);
  refuse(heldText(outcome.hold, cwd, outcome.again));
}
function readJsonText(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
main().catch((e) => {
  console.error(`[junco] ${e.message}`);
  refuse(`JUNCO's gate failed (${e.message}), so this call was not sent to PayPal.`);
  process.exit(0);
});
