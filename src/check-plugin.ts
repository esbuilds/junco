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
import { heldPolicy } from '../packages/junco-gate/src/policy.js';

// Manifests: PayPal's own layout (plugin.json, marketplace.json with source "./"), every listed part present.
const plugin = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
assert.equal(plugin.name, 'junco');
const market = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'));
const entry = market.plugins.find((p: any) => p.name === 'junco');
assert.ok(entry && entry.source === './' && entry.version === plugin.version, 'marketplace.json must list junco at ./ with the plugin version');
for (const p of [...entry.hooks, ...entry.skills]) assert.ok(existsSync(p), `${p} is listed in marketplace.json but missing`);
assert.match(readFileSync('skills/junco-gate/SKILL.md', 'utf8'), /^---\nname: junco-gate\ndescription: /, 'the skill needs its frontmatter');

// The matchers: PayPal's plugin's tools (mcp__plugin_paypal_paypal-sandbox__*) and a server added by hand as `paypal` on both
// events, plus the editor's own Bash and file-writing tools on PreToolUse for the routes around the gate. Every handler runs
// the bundle in exec form with a timeout.
const hooks = JSON.parse(readFileSync('hooks/hooks.json', 'utf8'));
const handler = [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/gate.mjs'], timeout: 20 }];
for (const ev of ['PreToolUse', 'PostToolUse']) {
  const m = hooks.hooks[ev].find((x: any) => x.matcher.startsWith('^mcp__'));
  assert.ok(m, `${ev} needs the PayPal matcher`);
  const re = new RegExp(m.matcher);
  for (const t of ['mcp__plugin_paypal_paypal-sandbox__create_refund', 'mcp__plugin_paypal_paypal-sandbox__get_order', 'mcp__paypal__create_refund']) assert.ok(re.test(t), `${ev} must match ${t}`);
  for (const t of ['Bash', 'Edit', 'mcp__plugin_junco_desk__create_refund', 'mcp__paypal-other__create_refund', 'mcp__junco__create_refund']) assert.ok(!re.test(t), `${ev} must not match ${t}`);
  assert.deepEqual(m.hooks, handler, `${ev} runs the bundle in exec form`);
}
assert.equal(hooks.hooks.PostToolUse.length, 1);
const guard = hooks.hooks.PreToolUse.find((x: any) => x.matcher === 'Bash|Write|Edit|MultiEdit|NotebookEdit');
assert.ok(guard && hooks.hooks.PreToolUse.length === 2, 'PreToolUse needs the guard on Bash and the file-writing tools');
assert.deepEqual(guard.hooks, handler);

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
function runTool(event: string, toolName: string, input: any, extra: Record<string, unknown> = {}, e: Record<string, string> = env, cwd = proj) {
  const body = { hook_event_name: event, tool_name: toolName, tool_input: input, cwd, session_id: 's1', tool_use_id: `tu-${Math.random().toString(36).slice(2, 8)}`, ...extra };
  const r = spawnSync('node', [gate], { cwd, env: e, encoding: 'utf8', input: JSON.stringify(body) });
  assert.equal(r.status, 0, r.stderr);
  return { out: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null, err: r.stderr };
}
const run = (event: string, method: string, input: any, extra: Record<string, unknown> = {}, e: Record<string, string> = env, cwd = proj) => runTool(event, tool(method), input, extra, e, cwd);

// Hook input that isn't JSON fails closed.
const bad = spawnSync('node', [gate], { cwd: proj, env, encoding: 'utf8', input: 'not json' });
assert.equal(bad.status, 0); assert.equal(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision, 'deny');

// The routes around the gate from the editor: the approve command, and changes to policy.json or .junco/, are refused; reads
// and unrelated commands get no decision.
for (const c of ['junco-gate approve 1234abcd --toolkit', 'cd /tmp && junco-gate --holds x approve 1234abcd', "echo '[]' > .junco/holds.json", "sed -i '' 's/hold/allow/' policy.json", 'cat policy.json | sed s/hold/allow/ > policy.json', 'rm -rf .junco', 'node -e "require(\'fs\').writeFileSync(\'.junco/holds.json\',\'[]\')"'])
  assert.equal(runTool('PreToolUse', 'Bash', { command: c }).out?.permissionDecision, 'deny', `Bash must be refused: ${c}`);
for (const c of ['cat .junco/holds.json', 'ls .junco', 'jq . policy.json', 'junco-gate holds', 'junco-gate reject 1234abcd', 'npm test', 'git status'])
  assert.equal(runTool('PreToolUse', 'Bash', { command: c }).out, null, `Bash must pass: ${c}`);
for (const [t, input] of [['Write', { file_path: `${proj}/policy.json`, content: '{}' }], ['Edit', { file_path: `${proj}/.junco/holds.json`, old_string: 'pending', new_string: 'completed' }], ['MultiEdit', { file_path: 'policy.json', edits: [] }], ['NotebookEdit', { notebook_path: `${root}/.junco/x.ipynb` }], ['Write', { file_path: `${root}/policy.json`, content: '{}' }]] as const)
  assert.equal(runTool('PreToolUse', t, input).out?.permissionDecision, 'deny', `${t} must be refused: ${JSON.stringify(input)}`);
for (const [t, input] of [['Write', { file_path: `${proj}/src/a.ts`, content: '' }], ['Edit', { file_path: `${proj}/README.md`, old_string: 'a', new_string: 'b' }]] as const)
  assert.equal(runTool('PreToolUse', t, input).out, null, `${t} must pass: ${JSON.stringify(input)}`);
assert.equal(runTool('PostToolUse', 'Bash', { command: 'junco-gate approve 1234abcd' }).out, null, 'the guard only decides before a call');
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

// The owner's line: `junco-gate approve` without a person at a terminal refuses before reading a token or connecting anywhere,
// and the hold stays pending. No PayPal variables are set here, so a token error would show if it got that far.
const cli = spawnSync('node_modules/.bin/tsx', ['packages/junco-gate/src/cli.ts', 'approve', h.id, '--toolkit', '--holds', join(proj, '.junco/holds.json')], { encoding: 'utf8', input: `${h.id}\n`, env: { PATH: process.env.PATH! } });
assert.equal(cli.status, 2, cli.stdout + cli.stderr);
assert.match(cli.stdout, /needs a person at a terminal/); assert.doesNotMatch(cli.stdout + cli.stderr, /PAYPAL_|token|npx/);
assert.equal(holds()[0].status, 'pending');

// Oct 31, the real test: a folder with no policy.json held the call under the plugin's own, and approve then looked only in the
// folder. The gate log names the file that made each hold, and the last line for that hold wins.
const logged = readFileSync(join(proj, '.junco/gate-log.jsonl'), 'utf8');
assert.match(String(heldPolicy(logged, h.id)), /policy\.json$/);
assert.equal(heldPolicy(`${JSON.stringify({ hold_id: 'a', policy: '/first' })}\nnot json\n${JSON.stringify({ hold_id: 'a', policy: '/last' })}\n`, 'a'), '/last');
assert.equal(heldPolicy(logged, 'no-such-hold'), undefined);

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
assert.match(doc, /not an OS boundary/); assert.match(doc, /fails? open/);
assert.match(readFileSync('README.md', 'utf8'), /docs\/plugin\.md/);

console.log(`check-plugin: matchers, fresh ${bundle.length}-byte bundle with node: imports only, clean copy with no node_modules, bad input and the routes around the gate refused, approve refused off a terminal, ${holds().length} holds none doubled, ${fit} of 8 parallel offers fit under the day at ${(total().cents / 100).toFixed(2)}, release on a 4xx only, project policy first, webhook line, docs: pass`);
