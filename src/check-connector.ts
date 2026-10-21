// S1 check: the sign-in a Claude connector does, against a running desk (DESK_URL, default http://localhost:3000; the desk
// must have DESK_PASSWORD set). 401 with the metadata pointer, both metadata documents, registration, the password page,
// code with PKCE, PayPal's hosted tools listed with the bearer token, refresh rotation, unknown client, revoke, and every
// OAuth endpoint under Claude's 10 s limit. Reads only: it lists tools and never calls one.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sandboxCtx } from './server.js';

await sandboxCtx(); // loads .env
const base = (process.env.DESK_URL ?? 'http://localhost:3000').replace(/\/$/, ''), pass = process.env.DESK_PASSWORD;
assert(pass, 'DESK_PASSWORD must be set (the judge password)');
const timed = async (label: string, url: string, init?: RequestInit) => {
  const t = Date.now(), r = await fetch(url, { redirect: 'manual', ...init }), ms = Date.now() - t;
  assert(ms < 10_000, `${label} took ${ms} ms; Claude allows 10 s`);
  console.log(`${label}: ${r.status} in ${ms} ms`);
  return r;
};
const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

for (const path of ['/mcp/paypal', '/mcp']) {
  const r = await timed(`POST ${path} without a token`, `${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource${path}"`);
  const prm = await (await timed(`protected-resource metadata ${path}`, `${base}/.well-known/oauth-protected-resource${path}`)).json();
  assert.equal(prm.resource, `${base}${path}`); assert.equal(prm.authorization_servers[0], base);
}
const as = await (await timed('authorization-server metadata', `${base}/.well-known/oauth-authorization-server`)).json();
assert.deepEqual(as.code_challenge_methods_supported, ['S256']); assert(as.registration_endpoint);

const redirect = 'https://claude.ai/api/mcp/auth_callback';
const reg = await timed('register', as.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'check-connector', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) });
assert.equal(reg.status, 201);
const { client_id } = await reg.json();
const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
const q = { client_id, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', scope: 'mcp', resource: `${base}/mcp/paypal` };
const page = await timed('authorize page', `${as.authorization_endpoint}?${new URLSearchParams(q)}`);
assert.equal(page.status, 200); assert.match(await page.text(), /name="password"/);
assert.equal((await timed('wrong password', as.authorization_endpoint, form({ ...q, username: 'judge', password: 'nope' }))).status, 401);
const ok = await timed('judge signs in', as.authorization_endpoint, form({ ...q, username: 'judge', password: pass }));
assert.equal(ok.status, 302);
const back = new URL(ok.headers.get('location')!);
assert.equal(back.origin + back.pathname, redirect); assert.equal(back.searchParams.get('state'), 'st8');
const code = back.searchParams.get('code')!;
assert.equal((await timed('code with a wrong verifier', as.token_endpoint, form({ grant_type: 'authorization_code', code, client_id, redirect_uri: redirect, code_verifier: 'x'.repeat(43) }))).status, 400);
// The failed try spent the code (single use), so sign in again for a fresh one.
const again = new URL((await fetch(as.authorization_endpoint, { redirect: 'manual', ...form({ ...q, username: 'judge', password: pass }) })).headers.get('location')!);
const tok = await (await timed('token', as.token_endpoint, form({ grant_type: 'authorization_code', code: again.searchParams.get('code')!, client_id, redirect_uri: redirect, code_verifier: verifier }))).json();
assert(tok.access_token && tok.refresh_token);

const listed = async (auth: string, label: string) => {
  const c = new Client({ name: 'check-connector', version: '0' });
  const t0 = Date.now();
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/paypal`), { requestInit: { headers: { Authorization: auth } } }));
  const tools = (await c.listTools()).tools;
  await c.close();
  console.log(`tools/list over /mcp/paypal with ${label}: ${tools.length} tools in ${Date.now() - t0} ms`);
  return tools.map((t) => t.name);
};
const names = await listed(`Bearer ${tok.access_token}`, 'the bearer token');
assert(names.includes('accept_dispute_claim') && names.includes('create_refund') && !names.includes('pay_order'));
assert.deepEqual(await listed(`Basic ${Buffer.from(`judge:${pass}`).toString('base64')}`, 'the desk password (the mcp-remote path)'), names);

const r1 = await (await timed('refresh', as.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id }))).json();
assert(r1.access_token && r1.refresh_token !== tok.refresh_token);
const reused = await timed('old refresh token again', as.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id }));
assert.equal(reused.status, 400); assert.equal((await reused.json()).error, 'invalid_grant');
const unknown = await timed('unknown client', as.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: r1.refresh_token, client_id: 'junco_nope' }));
assert.equal(unknown.status, 401); assert.equal((await unknown.json()).error, 'invalid_client');
await timed('revoke', as.revocation_endpoint, form({ token: r1.access_token }));
const after = await fetch(`${base}/mcp/paypal`, { method: 'POST', headers: { Authorization: `Bearer ${r1.access_token}`, 'Content-Type': 'application/json' }, body: '{}' });
assert.equal(after.status, 401); console.log('revoked token -> 401');
console.log('connector: ok');
process.exit(0);
