// The judges' door, offline: exactly which paths open without the desk password (public.ts), that every other path stays
// behind it, that the desk wires the door in before its 401, that the incident page and the drill page only fetch open paths
// (no browser password box), that a visitor's own shopping runs never open for the public, and what /judges shows. The drill's
// run route is the one open route that calls Claude; check-drill pins its caps.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPublic, PUBLIC_GET, PUBLIC_POST, PUBLIC_SESSION } from './public.js';

const ID = 'AAAAAAAAAAAAAAAA1';
const open: [string, string][] = [['GET', '/judges'], ['GET', '/api/incidents'], ['GET', `/incident/${ID}`], ['GET', `/incident/${ID}/receipt`],
  ['GET', `/api/incident/${ID}`], ['GET', '/incident/decline-20261029162810201'], ['GET', '/run/c5b289d1'], ['POST', `/api/incident/${ID}/what-if`],
  ['GET', '/drill'], ['GET', '/api/drill/score'], ['POST', '/api/drill/run'], ['GET', '/api/drill/run/0f2c6d1e-aaaa-4bbb-8ccc-123456789abc'],
  ['GET', '/who-else'], ['GET', '/api/who-else'], ['POST', '/api/who-else/run'], ['GET', '/api/who-else/run/0f2c6d1e-aaaa-4bbb-8ccc-123456789abc']];
const closed: [string, string][] = [
  // the desk, Studio and everything that acts, spends or reads PayPal
  ['GET', '/'], ['GET', '/owner'], ['GET', '/?page=incident'], ['GET', '/api/shop'], ['POST', '/api/shop'], ['GET', '/api/challenge'], ['POST', '/api/challenge'],
  ['GET', '/api/challenge/stats'], ['GET', '/api/start'], ['GET', '/api/status'], ['POST', '/api/status/check'], ['GET', '/api/disputes'], ['GET', '/api/holds'],
  ['POST', '/api/holds/h1/approve'], ['GET', '/api/policy'], ['POST', '/api/policy'], ['POST', '/api/policy/what-if'], ['POST', '/api/pool'], ['POST', '/api/studio-ai'],
  ['POST', '/api/refund-ask'], ['GET', '/api/refund-ask'], ['POST', '/api/red-team/run'], ['POST', '/api/connectors/revoke'], ['GET', '/mcp'], ['POST', '/mcp'], ['GET', '/mcp/paypal'], ['POST', '/mcp/paypal'], ['POST', '/mcp/challenge'],
  // near misses on the open paths: other methods, other tails, other depths, encoded slashes
  ['POST', '/judges'], ['POST', '/api/incidents'], ['POST', `/incident/${ID}`], ['POST', `/api/incident/${ID}`], ['PUT', `/api/incident/${ID}/what-if`], ['GET', `/api/incident/${ID}/what-if`],
  ['DELETE', `/api/incident/${ID}`], ['HEAD', '/judges'], ['GET', `/api/incident/${ID}/receipt`], ['GET', `/incident/${ID}/other`], ['GET', `/incident/${ID}/receipt/x`],
  ['GET', '/judges/x'], ['GET', '/api/incidents/x'], ['GET', '/run/x/y'], ['GET', '/incident/a%2F..%2Fapi'], ['GET', '/incident/'], ['GET', '/run/'], ['GET', `//incident/${ID}`],
  ['GET', `/incident/${'x'.repeat(65)}`], ['GET', '/judges?x=1#'],
  ['POST', '/drill'], ['GET', '/drill/x'], ['GET', '/api/drill'], ['POST', '/api/drill'], ['GET', '/api/drill/run'], ['POST', '/api/drill/run/x'], ['PUT', '/api/drill/run'],
  ['POST', '/api/drill/score'], ['GET', '/api/drill/run/x/y'], ['GET', `/api/drill/run/${'x'.repeat(65)}`],
  ['POST', '/who-else'], ['GET', '/who-else/x'], ['POST', '/api/who-else'], ['GET', '/api/who-else/note'], ['POST', '/api/who-else/note'], ['GET', '/api/who-else/run'], ['POST', '/api/who-else/run/x'],
  ['GET', '/api/who-else/run/x/y'], ['POST', '/api/who-else/run/x/plan'], ['POST', '/api/who-else/run/x/approve-all'], ['POST', '/api/who-else/run/x/notify'], ['POST', '/api/who-else/run/x/correct'], ['GET', `/api/who-else/run/${'x'.repeat(65)}`],
];
for (const [m, p] of open) assert.ok(isPublic(m, p), `${m} ${p} should open`);
for (const [m, p] of closed) assert.ok(!isPublic(m, p), `${m} ${p} must stay behind the password`);
console.log(`allowlist: ${open.length} open, ${closed.length} closed (PUBLIC_GET ${PUBLIC_GET}, PUBLIC_POST ${PUBLIC_POST})`);

// The desk: the door comes before the 401, as a non-owner public actor with noindex; the public what-if drops no cache.
const desk = readFileSync('src/desk.ts', 'utf8');
const door = desk.indexOf("if (!authorized(req) && isPublic(req.method, url.pathname)) { res.setHeader('X-Robots-Tag', 'noindex'); return actor.run({ owner: false, session: PUBLIC_SESSION }, () => route(req, res, url)); }");
const wall = desk.indexOf("if (!authorized(req)) { res.writeHead(401");
assert.ok(door > 0 && wall > door, 'the desk no longer opens the judges\' door right before its 401');
assert.ok(desk.includes("url.pathname !== '/api/studio-ai' && !isPublic(req.method, url.pathname)) dropCases()"));
// The incident page fetches only open paths, so a signed-out judge never meets the browser's password box.
// The one closed path it can post to is the refund ask, and only from a button drawn when the incident says this viewer
// may ask (refund.can_ask, false for the public), so signed out it never fires.
const page = readFileSync('public/incident.html', 'utf8'), fetches = [...page.matchAll(/fetch\((?:`([^`]+)`|'([^']+)')/g)].map((m) => m[1] ?? m[2]);
assert.deepEqual(fetches.sort(), ['/api/incident/${encodeURIComponent(id)}', '/api/incident/${encodeURIComponent(inc.id)}/what-if', '/api/refund-ask']);
for (const f of fetches.filter((x) => x !== '/api/refund-ask')) assert.ok(isPublic(f.endsWith('what-if') ? 'POST' : 'GET', f.replace(/\$\{[^}]+\}/, ID)));
assert.ok(!isPublic('POST', '/api/refund-ask') && page.includes("if (r.ask) { $('#refund').innerHTML = askText(r.ask) + demoBox(r.demo); return; }\n  if (!r.can_ask) return;"));
assert.ok(page.includes('Desk (sign in to act)'));
// The drill page: open paths on the desk, and the planter from the visitor's browser.
const drill = readFileSync('public/drill.html', 'utf8'), drillFetches = [...drill.matchAll(/fetch\((?:`([^`]+)`|'([^']+)')/g)].map((m) => m[1] ?? m[2]);
assert.deepEqual(drillFetches.sort(), ['${window.PLANTER_URL}/plant', '/api/drill/run', '/api/drill/run/${encodeURIComponent(id)}', '/api/drill/score'].sort());
for (const f of drillFetches.filter((x) => x.startsWith('/'))) assert.ok(isPublic(f === '/api/drill/run' ? 'POST' : 'GET', f.replace(/\$\{[^}]+\}/, ID)));
console.log('desk: the door sits before the 401; the incident and drill pages fetch only open paths, and a refund ask posts only when it may');

// Records: a pool purchase and a pool decline (public), a visitor's own buy and decline (private to their session).
globalThis.fetch = (async () => { throw new Error('check-public: no network'); }) as any;
delete process.env.DATABASE_URL;
process.chdir(mkdtempSync(join(tmpdir(), 'junco-public-')));
mkdirSync('.junco');
const agent = { instruction: 'a bag', budget: '70.00', sku: 'WKD-01', listing: 'WKD-01 listing', reason: 'fits', agent: 'Check shopper', capture_id: 'CAPPOOL1', paid_at: '2026-10-20T10:00:00.000Z' };
const S = 'b'.repeat(36);
const put = (f: string, v: unknown) => writeFileSync(`.junco/${f}`, JSON.stringify(v));
put('pool.json', [{ buyer_txn: ID, amount: '62.00', order_id: 'ORDPOOL1', tracking: false, agent, added: '2026-10-20T10:01:00.000Z' }]);
put('declines.json', [
  { id: 'decline-20261029162810201', at: '2026-10-29T16:28:10.201Z', instruction: 'Get me a waterproof weekend bag I can take kayaking, under $70.', budget: '70.00', reason: 'WKD-02 costs $74.', agent: 'x', listings: ['a', 'b', 'c'], added: '2026-10-29T16:28:11.000Z' },
  { id: 'decline-20261029170000000', at: '2026-10-29T17:00:00.000Z', instruction: 'my secret typed ask', budget: '20.00', reason: 'no', agent: 'x', listings: [], added: '2026-10-29T17:00:01.000Z', session: S }]);
put('agent-buys.json', [{ capture_id: 'CAPVISITOR1', order_id: 'ORDVISITOR1', amount: '38.00', session: S, added: '2026-10-29T18:00:00.000Z', agent: { ...agent, instruction: 'another secret ask', capture_id: 'CAPVISITOR1' } }]);
const { actor } = await import('./store-dispute.js');
const { listIncidents, buildIncident } = await import('./incident.js');
const { judgesPage } = await import('./incident-view.js');
const pub = { owner: false, session: PUBLIC_SESSION };
const pubIds = actor.run(pub, listIncidents).map((i) => i.id);
assert.deepEqual(pubIds.sort(), [ID, 'decline-20261029162810201'].sort());
for (const id of ['CAPVISITOR1', 'ORDVISITOR1', 'decline-20261029170000000']) {
  assert.equal(actor.run(pub, () => buildIncident(id)), null, `${id} opened for the public`);
  assert.ok(actor.run({ owner: false, session: S }, () => buildIncident(id)), `${id} closed for its own visitor`);
  assert.ok(actor.run({ owner: true, session: 'o' }, () => buildIncident(id)), `${id} closed for the owner`);
}
assert.equal(actor.run(pub, () => buildIncident('CAPPOOL1'))?.id, ID); // prepared purchases open by any of their ids
console.log('records: the public list and links show prepared purchases and pool declines, never a visitor\'s own run');

// /judges from the public list.
const all = actor.run(pub, listIncidents);
const html = judgesPage({ purchases: all.filter((i) => !i.id.startsWith('decline-')), decline: all.find((i) => i.id.startsWith('decline-')) ?? null,
  escape: { attempts: 3, escapes: 0, escape_runs: [] }, rooms: [{ id: 'c5b289d1', at: '2026-10-29T17:05:00.000Z', room: 1, title: 'Fair complaint', outcome: 'No money moved: JUNCO answered with a message (policy: send_dispute_message = allow).' }],
  drill: { hidden: 4, found: 3, missed: 0, false_alarms: 0, money_moved_usd: 0 } });
for (const want of [`/incident/${ID}"`, `/incident/${ID}/receipt"`, '/incident/decline-20261029162810201"', '/run/c5b289d1"', '3 attempts, 0 escapes.', '4 hidden, 3 found, 0 missed, 0 false alarms.', 'Money moved by the investigator: $0.00', 'href="/drill"', 'Sign in to act', 'href="/"', "PayPal's sandbox with test accounts", 'No password is needed to look', 'noindex'])
  assert.ok(html.includes(want), `/judges lacks ${want}`);
for (const bad of ['undefined', 'null', 'secret', 'CAPVISITOR1', '—']) assert.ok(!html.includes(bad), `/judges shows ${bad}`);
// Every link on it opens without the password, except the desk itself.
for (const [, href] of html.matchAll(/href="(\/[^"]*)"/g)) assert.ok(href === '/' || isPublic('GET', href), `/judges links to ${href}, which needs the password`);
console.log('judges: the public list, the decline, the counter and room runs, and "Sign in to act"; every link opens signed out');
console.log('public: ok');
