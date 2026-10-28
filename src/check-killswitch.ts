// Kill switch check, offline, on a fixture token store in a temp directory (the repo's .junco/oauth.json is never read):
// revoking signs every connector out, so a bearer that worked gets the plain 401 and a refresh can't bring it back;
// client registrations stay; the revocation is logged and shows in an incident. Token values are fixtures, never printed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

delete process.env.DATABASE_URL;
process.chdir(mkdtempSync(join(tmpdir(), 'junco-killswitch-')));
mkdirSync('.junco');
const hash = (t: string) => createHash('sha256').update(t).digest('hex'), later = Date.now() + 3600_000;
const client = (name: string) => ({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], name, at: Date.now() });
writeFileSync('.junco/oauth.json', JSON.stringify({ clients: { c1: client('Claude'), c2: client('Claude Code') }, tokens: {
  [hash('access-1')]: { kind: 'access', client_id: 'c1', role: 'judge', exp: later }, [hash('refresh-1')]: { kind: 'refresh', client_id: 'c1', role: 'judge', exp: later },
  [hash('access-2')]: { kind: 'access', client_id: 'c2', role: 'owner', exp: later } } }));
writeFileSync('.junco/pool.json', JSON.stringify([{ buyer_txn: 'AAAAAAAAAAAAAAAA1', amount: '62.00', agent: { instruction: 'bag', budget: '70', sku: 'WKD-01', listing: 'l', reason: 'r', agent: 'a' }, added: '2026-10-20T10:00:00.000Z' }]));

const { bearer, challenge, connectorSessions, oauth, revokeAll } = await import('./oauth.js');
const req = (token?: string, body = '') => ({ headers: token ? { authorization: `Bearer ${token}` } : {}, url: '/token', method: 'POST', body }) as any;
const res = () => { const r: any = { code: 0, body: '', writeHead(c: number) { r.code = c; return r; }, end(b: string) { r.body = b; } }; return r; };

assert.equal(bearer(req('access-1'))?.role, 'judge'); assert.equal(bearer(req('access-2'))?.role, 'owner');
assert.equal(connectorSessions(), 2);
const r = revokeAll();
assert.equal(r.sessions, 2); assert.equal(connectorSessions(), 0);
assert.equal(bearer(req('access-1')), null); assert.equal(bearer(req('access-2')), null);
console.log('revoke: both signed-in connectors lose their access tokens at once');

const out = res(); challenge(out, 'https://desk', '/mcp/paypal', req('access-1'));
assert.equal(out.code, 401); assert.match(JSON.parse(out.body).error_description, /owner disconnected every connector at .* UTC\. Sign in again/);
const fresh = res(); challenge(fresh, 'https://desk', '/mcp/paypal', req());
assert.equal(JSON.parse(fresh.body).error_description, 'Sign in to use this desk'); // a client that never had a token isn't told about it
const refresh = res();
assert.equal(await oauth(req(undefined), refresh, 'https://desk', async () => 'grant_type=refresh_token&client_id=c1&refresh_token=refresh-1'), true);
assert.equal(refresh.code, 400); assert.equal(JSON.parse(refresh.body).error, 'invalid_grant');
console.log('next call: a plain 401 saying the owner disconnected it; the refresh token is dead too, so it must sign in again');

const saved = JSON.parse(readFileSync('.junco/oauth.json', 'utf8'));
assert.deepEqual(Object.keys(saved.tokens), []); assert.deepEqual(Object.keys(saved.clients).sort(), ['c1', 'c2']); // signing in again is one step
assert.deepEqual(JSON.parse(readFileSync('.junco/revocations.json', 'utf8')), [r]);
const { buildIncident } = await import('./incident.js');
const ev = buildIncident('AAAAAAAAAAAAAAAA1')!.events.find((e) => e.id === `revoke:${r.at}`);
assert.equal(ev?.actor, 'owner'); assert.match(ev!.summary, /disconnected every Claude connector \(2 signed in\)/);
console.log('record: registrations kept, the revocation logged and shown on the incident');
console.log('killswitch: ok');
