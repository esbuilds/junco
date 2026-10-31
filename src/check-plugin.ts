// The Claude Code plugin, offline: PayPal's plugin's tool names hit the matcher and nothing else does, the committed bundle
// hooks/gate.mjs is fresh and carries only Node built-ins, it runs from a clean copy of the plugin with no node_modules, a
// held call is stored exactly as asked and never doubled, the daily total holds across parallel hook processes, a definite
// PayPal refusal gives a reservation back and an unknown outcome keeps it, the project's policy wins over the plugin's, the
// Slack line goes out, and the docs say what PayPal's own server does today.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definiteRefusal } from '../packages/junco-gate/src/paypal.js';

// Manifests: PayPal's own layout (plugin.json, marketplace.json with source "./"), every listed part present.
const plugin = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
assert.equal(plugin.name, 'junco');
const market = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'));
const entry = market.plugins.find((p: any) => p.name === 'junco');
assert.ok(entry && entry.source === './' && entry.version === plugin.version, 'marketplace.json must list junco at ./ with the plugin version');
for (const p of [...entry.hooks, ...entry.skills]) assert.ok(existsSync(p), `${p} is listed in marketplace.json but missing`);
assert.match(readFileSync('skills/junco-gate/SKILL.md', 'utf8'), /^---\nname: junco-gate\ndescription: /, 'the skill needs its frontmatter');

// The matcher: PayPal's plugin's tools (mcp__plugin_paypal_paypal-sandbox__*) and a server added by hand as `paypal`, nothing else.
const hooks = JSON.parse(readFileSync('hooks/hooks.json', 'utf8'));
for (const ev of ['PreToolUse', 'PostToolUse']) {
  const m = hooks.hooks[ev];
  assert.equal(m?.length, 1, `${ev} needs one matcher`);
  const re = new RegExp(m[0].matcher);
  for (const t of ['mcp__plugin_paypal_paypal-sandbox__create_refund', 'mcp__plugin_paypal_paypal-sandbox__get_order', 'mcp__paypal__create_refund']) assert.ok(re.test(t), `${ev} must match ${t}`);
  for (const t of ['Bash', 'Edit', 'mcp__plugin_junco_desk__create_refund', 'mcp__paypal-other__create_refund', 'mcp__junco__create_refund']) assert.ok(!re.test(t), `${ev} must not match ${t}`);
  assert.deepEqual(m[0].hooks, [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/gate.mjs'] }], `${ev} runs the bundle in exec form`);
}

// The bundle: what hooks.json runs is the committed file, so it must equal a fresh build and import only node: built-ins.
const fresh = join(mkdtempSync(join(tmpdir(), 'junco-bundle-')), 'gate.mjs');
const built = spawnSync('node_modules/.bin/esbuild', ['hooks/gate.ts', '--bundle', '--platform=node', '--format=esm', '--target=node22', `--outfile=${fresh}`, '--log-level=warning'], { encoding: 'utf8' });
assert.equal(built.status, 0, built.stderr);
const bundle = readFileSync('hooks/gate.mjs', 'utf8');
assert.equal(bundle, readFileSync(fresh, 'utf8'), 'hooks/gate.mjs is stale: run `npm run build:plugin` and commit it');
assert.ok(!/modelcontextprotocol/.test(bundle), 'the bundle must not carry the MCP SDK');
for (const m of bundle.matchAll(/\bfrom "([^"]+)"/g)) assert.ok(m[1].startsWith('node:'), `the bundle imports ${m[1]}; only node: built-ins may remain`);

// A clean copy of the plugin, as the plugin cache holds it: the plugin's files and nothing else, no node_modules.
const root = mkdtempSync(join(tmpdir(), 'junco-plugin-'));
for (const f of ['.claude-plugin', 'hooks', 'skills', 'policy.json']) cpSync(f, join(root, f), { recursive: true });
assert.ok(!existsSync(join(root, 'node_modules')));
const proj = mkdtempSync(join(tmpdir(), 'junco-proj-'));
const env = { PATH: process.env.PATH!, CLAUDE_PLUGIN_ROOT: root }; // no PayPal credentials, no webhook
const tool = (m: string) => `mcp__plugin_paypal_paypal-sandbox__${m}`;
const gate = join(root, 'hooks/gate.mjs');
function run(event: string, method: string, input: any, extra: Record<string, unknown> = {}, e: Record<string, string> = env, cwd = proj) {
  const body = { hook_event_name: event, tool_name: tool(method), tool_input: input, cwd, session_id: 's1', tool_use_id: `tu-${Math.random().toString(36).slice(2, 8)}`, ...extra };
  const r = spawnSync('node', [gate], { cwd, env: e, encoding: 'utf8', input: JSON.stringify(body) });
  assert.equal(r.status, 0, r.stderr);
  return { out: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null, err: r.stderr };
}
const holds = (): any[] => JSON.parse(readFileSync(join(proj, '.junco/holds.json'), 'utf8'));
const total = (): any => JSON.parse(readFileSync(join(proj, '.junco/daily-total.json'), 'utf8'));
const lastLog = (): any => JSON.parse(readFileSync(join(proj, '.junco/gate-log.jsonl'), 'utf8').trim().split('\n').at(-1)!);

// A read: no decision from the hook (Claude Code's own flow applies), logged as allowed.
let r = run('PreToolUse', 'get_order', { order_id: 'O1' });
assert.equal(r.out, null); assert.equal(lastLog().verdict, 'allow');

// A refund: held, stored exactly as asked, the reason names the hold id and the approve command, and says nothing was sent.
const refund = { capture_id: '2PK077076W844320N', amount: { value: '62.00', currency_code: 'USD' }, note_to_payer: 'test' };
r = run('PreToolUse', 'create_refund', refund);
assert.equal(r.out?.permissionDecision, 'deny');
assert.equal(holds().length, 1);
const h = holds()[0];
assert.deepEqual(h.args, refund); assert.equal(h.method, 'create_refund'); assert.equal(h.status, 'pending'); assert.equal(h.origin, 'claude-code-plugin');
assert.match(r.out.permissionDecisionReason, new RegExp(`Hold ${h.id}: create_refund`));
assert.match(r.out.permissionDecisionReason, /Nothing was sent to PayPal/);
assert.match(r.out.permissionDecisionReason, new RegExp(`junco-gate approve ${h.id} --toolkit`));
assert.equal(lastLog().hold_id, h.id);

// The same call again: no second hold, the same id back.
r = run('PreToolUse', 'create_refund', refund);
assert.equal(holds().length, 1);
assert.match(r.out.permissionDecisionReason, new RegExp(`already held.*Hold ${h.id}`));
// A different amount on the same capture is its own hold.
r = run('PreToolUse', 'create_refund', { ...refund, amount: { value: '10.00', currency_code: 'USD' } });
assert.equal(holds().length, 2);
// Once the first ran, the same call is refused, not held again.
const hs = holds(); hs[0].status = 'completed'; writeFileSync(join(proj, '.junco/holds.json'), JSON.stringify(hs));
r = run('PreToolUse', 'create_refund', refund);
assert.equal(holds().length, 2); assert.match(r.out.permissionDecisionReason, /already ran as hold/);

// Denied: a hidden tool, and one the policy doesn't name (default deny). No hold.
r = run('PreToolUse', 'pay_order', { id: 'O1' });
assert.equal(r.out?.permissionDecision, 'deny'); assert.match(r.out.permissionDecisionReason, /Not allowed by the owner's policy/);
r = run('PreToolUse', 'delete_everything', {});
assert.equal(r.out?.permissionDecision, 'deny'); assert.equal(holds().length, 2);

// Allowed: a message passes with no decision; an offer within the limit passes and counts; one over the limit holds and doesn't count.
r = run('PreToolUse', 'send_dispute_message', { dispute_id: 'D1', message: 'hi' });
assert.equal(r.out, null);
const offer = (d: string, v: string) => ({ dispute_id: d, offer_amount: { value: v, currency_code: 'USD' } });
r = run('PreToolUse', 'make_dispute_offer', offer('D1', '10.00'), { tool_use_id: 'tu-offer-10' });
assert.equal(r.out, null); assert.equal(total().cents, 1000); assert.equal(total().open['tu-offer-10'], 1000);
r = run('PreToolUse', 'make_dispute_offer', offer('D2', '30.00'));
assert.equal(r.out?.permissionDecision, 'deny'); assert.match(r.out.permissionDecisionReason, /over the 25 limit/);
assert.equal(holds().length, 3); assert.equal(total().cents, 1000);

// After the call: a definite PayPal refusal (4xx) gives the reservation back; a 5xx or a success keeps it. The hosted server's
// outage shape (paypal/agent-toolkit#119) follows definiteRefusal, the same rule the desk uses.
const post = (id: string, text: string, isError?: boolean) => run('PostToolUse', 'make_dispute_offer', offer('D1', '10.00'), { tool_use_id: id, tool_response: { content: [{ type: 'text', text }], ...(isError && { isError }) } });
post('tu-offer-10', '{"ok":false,"status":422,"code":"PAYPAL_API_HTTP_ERROR","message":"nope"}', true);
assert.equal(total().cents, 0); assert.equal(total().open['tu-offer-10'], undefined); assert.equal(lastLog().verdict, 'release');
run('PreToolUse', 'make_dispute_offer', offer('D3', '10.00'), { tool_use_id: 'tu-b' });
post('tu-b', '{"ok":false,"status":500,"code":"PAYPAL_API_HTTP_ERROR","message":"oops"}', true);
assert.equal(total().cents, 1000, 'a 5xx may have landed: the reservation stays');
post('tu-b', '{"id":"OFFER-1","status":"OK"}');
assert.equal(total().cents, 1000, 'a success keeps its reservation');
const outage = '{"ok":false,"code":"PAYPAL_API_SETUP_ERROR","message":"Unsupported cache mode: default"}';
run('PreToolUse', 'make_dispute_offer', offer('D4', '5.00'), { tool_use_id: 'tu-119' });
post('tu-119', outage, true);
assert.equal(total().cents, definiteRefusal(outage) ? 1000 : 1500, 'the #119 shape follows definiteRefusal');

// The race: eight hooks at once, each a 20 USD offer against the 100 USD day. Exactly as many pass as fit; the rest hold; the
// total never passes 100; no lock is left behind.
const before = total().cents, fit = Math.floor((10000 - before) / 2000);
const race = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise<{ code: number | null; out: string }>((resolve) => {
  const c = spawn('node', [gate], { cwd: proj, env });
  let out = ''; c.stdout.on('data', (d) => { out += d; });
  c.on('close', (code) => resolve({ code, out }));
  c.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool('make_dispute_offer'), tool_input: offer(`R${i}`, '20.00'), cwd: proj, tool_use_id: `tu-race-${i}` }));
})));
assert.ok(race.every((x) => x.code === 0));
const passed = race.filter((x) => !x.out).length;
assert.equal(passed, fit, `${passed} of 8 parallel offers passed; ${fit} fit under the total`);
assert.ok(race.filter((x) => x.out).every((x) => /daily total was reached/.test(JSON.parse(x.out).hookSpecificOutput.permissionDecisionReason)));
assert.equal(total().cents, before + fit * 2000); assert.ok(total().cents <= 10000);
assert.equal(holds().filter((x) => x.method === 'make_dispute_offer').length, 1 + 8 - fit);
assert.ok(!readdirSync(join(proj, '.junco')).some((f) => f.endsWith('.lock')), 'no lock left behind');

// The project's own policy.json wins over the plugin's; with no policy anywhere, nothing goes through.
writeFileSync(join(proj, 'policy.json'), JSON.stringify({ default: 'deny', tools: { create_refund: 'allow' } }));
r = run('PreToolUse', 'create_refund', { capture_id: 'X', amount: { value: '1.00', currency_code: 'USD' } });
assert.equal(r.out, null); assert.equal(lastLog().policy, join(proj, 'policy.json'));
const bare = mkdtempSync(join(tmpdir(), 'junco-bare-'));
r = run('PreToolUse', 'get_order', { order_id: 'O1' }, {}, { PATH: process.env.PATH!, CLAUDE_PLUGIN_ROOT: bare }, bare);
assert.equal(r.out?.permissionDecision, 'deny'); assert.match(r.out.permissionDecisionReason, /no policy\.json/);

// Slack: with HOLD_WEBHOOK_URL set, a new hold posts one line naming the id and the approve command. The hook is spawned
// asynchronously here because the test's own server has to answer it.
const posts: string[] = [];
const srv = createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { posts.push(b); res.end('ok'); }); });
await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
const port = (srv.address() as any).port;
const proj2 = mkdtempSync(join(tmpdir(), 'junco-proj2-'));
await new Promise<void>((resolve) => {
  const c = spawn('node', [gate], { cwd: proj2, env: { ...env, HOLD_WEBHOOK_URL: `http://127.0.0.1:${port}/hook` } });
  c.on('close', (code) => { assert.equal(code, 0); resolve(); });
  c.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool('create_refund'), tool_input: refund, cwd: proj2, tool_use_id: 'tu-slack' }));
});
srv.close();
const id2 = JSON.parse(readFileSync(join(proj2, '.junco/holds.json'), 'utf8'))[0].id;
assert.equal(posts.length, 1); assert.match(JSON.parse(posts[0]).text, new RegExp(`create_refund.*\\n.*\\n.*junco-gate approve ${id2} --toolkit`));

// Docs: the plugin page says plainly that PayPal's own server fails today and names the issue; the README points at it.
const doc = readFileSync('docs/plugin.md', 'utf8');
assert.match(doc, /paypal\/agent-toolkit#119/); assert.match(doc, /can fail|fails/);
assert.match(readFileSync('README.md', 'utf8'), /docs\/plugin\.md/);

console.log(`check-plugin: matcher, fresh ${bundle.length}-byte bundle with node: imports only, clean copy with no node_modules, ${holds().length} holds none doubled, ${fit} of 8 parallel offers fit under the day at ${(total().cents / 100).toFixed(2)}, release on a 4xx only, project policy first, webhook line, docs: pass`);
