// S1: the desk as its own OAuth server, so claude.ai, Claude Desktop, Claude mobile and Claude Code add /mcp/paypal (or
// /mcp) as a custom connector by URL alone. Claude registers itself (DCR, a public client with PKCE), the person signs in
// on a password page (username "judge" and the desk password: visitor rights; the owner token: owner rights), and every
// MCP call then carries a bearer token. The Basic-password path (mcp-remote) keeps working beside it.
// Clients and tokens live in .junco/oauth.json, mirrored to Postgres like the rest of the desk, so a deploy keeps them.
// Tokens are stored as hashes. ponytail: sign-in codes live in memory; a restart mid-sign-in means signing in again.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import assert from 'node:assert/strict';
import { mirror } from './persist.js';

const FILE = '.junco/oauth.json';
const ACCESS_S = 3600, REFRESH_MS = 30 * 86400_000, CODE_MS = 10 * 60_000, MAX_CLIENTS = 500;
export type Role = 'owner' | 'judge';
type Client = { redirect_uris: string[]; name: string; at: number };
type Token = { kind: 'access' | 'refresh'; client_id: string; role: Role; exp: number };
type Store = { clients: Record<string, Client>; tokens: Record<string, Token> };
const codes = new Map<string, { client_id: string; redirect_uri: string; challenge: string; role: Role; exp: number }>();

let store: Store | null = null;
const load = (): Store => store ??= (() => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { clients: {}, tokens: {} }; } })();
function save() {
  const s = load(), now = Date.now();
  for (const [k, t] of Object.entries(s.tokens)) if (t.exp < now) delete s.tokens[k];
  mkdirSync('.junco', { recursive: true }); writeFileSync(FILE, JSON.stringify(s)); mirror(FILE, s);
}
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const mint = () => randomBytes(32).toString('base64url');
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export const pkceOk = (verifier: string, challenge: string) => !!verifier && same(createHash('sha256').update(verifier).digest('base64url'), challenge);
// Exact match, except a loopback redirect (Claude Code) matches on any port, as RFC 8252 and Claude's docs ask.
export function redirectOk(registered: string[], asked: string) {
  let a: URL; try { a = new URL(asked); } catch { return false; }
  return registered.some((r) => {
    if (r === asked) return true;
    const u = new URL(r), loop = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    return u.protocol === 'http:' && loop(u.hostname) && a.protocol === 'http:' && loop(a.hostname) && u.pathname === a.pathname;
  });
}
const validRedirect = (r: unknown) => { try { const u = new URL(String(r)); return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)); } catch { return false; } };

// Who a bearer token belongs to, or null. The caller decides what a missing or bad token means.
export function bearer(req: IncomingMessage): { role: Role; client_id: string; client: string } | null {
  const [scheme, value] = String(req.headers.authorization ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
  const t = load().tokens[hash(value)];
  if (!t || t.kind !== 'access' || t.exp < Date.now()) return null;
  return { role: t.role, client_id: t.client_id, client: load().clients[t.client_id]?.name ?? 'an MCP client' };
}
// The 401 that starts Claude's sign-in: it points at this resource's metadata.
export const challenge = (res: ServerResponse, base: string, path: string) => {
  res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource${path}"` });
  res.end(JSON.stringify({ error: 'invalid_token', error_description: 'Sign in to use this desk' }));
};

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PARAMS = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource', 'response_type'];
const loginPage = (q: Record<string, string>, client: string, err?: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>JUNCO: sign in</title><style>
:root{color-scheme:light dark;--bg:#f7f5f0;--ink:#1d2421;--m:#5d6662;--acc:#1f5c4a;--danger:#a8322a}
@media (prefers-color-scheme:dark){:root{--bg:#141816;--ink:#e8ece9;--m:#9aa49f;--acc:#5fb497;--danger:#ef8a80}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--ink);font:16px/1.45 Inter,system-ui,sans-serif;max-width:560px}
h1{font-size:21px;margin:0 0 8px}.m{color:var(--m)}.err{color:var(--danger);font-weight:600}
label{display:block;margin:14px 0 4px;font-weight:600}input{box-sizing:border-box;width:100%;font:inherit;padding:12px;border-radius:10px;border:1px solid var(--m);background:transparent;color:var(--ink)}
button{margin-top:20px;width:100%;font:inherit;font-weight:600;padding:14px;border-radius:10px;border:1px solid var(--acc);background:var(--acc);color:#fff}
</style></head><body><p class="m"><strong>JUNCO</strong> · sign in</p>
<h1>Connect ${esc(client)} to the JUNCO desk</h1>
<p class="m">It gets PayPal's sandbox tools behind the owner's gate: reads run, small writes run under the owner's limits, anything bigger waits for the owner. Judges: username <strong>judge</strong>, password from the testing instructions.</p>
${err ? `<p class="err">${esc(err)}</p>` : ''}
<form method="post" action="/authorize">${PARAMS.map((k) => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join('')}
<label for="u">Username</label><input id="u" name="username" autocomplete="username" value="judge">
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" autofocus>
<button>Sign in and connect</button></form></body></html>`;

type Reply = (code: number, body: unknown, headers?: Record<string, string>) => void;
// Handles the OAuth routes; false when the path isn't one of them. Runs before the desk password check.
export async function oauth(req: IncomingMessage, res: ServerResponse, base: string, readRaw: (r: IncomingMessage, limit?: number) => Promise<string>, password?: string): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x'), p = url.pathname;
  const send: Reply = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && p.startsWith('/.well-known/oauth-protected-resource')) {
    const resource = p.slice('/.well-known/oauth-protected-resource'.length) || '/mcp/paypal';
    if (resource !== '/mcp' && resource !== '/mcp/paypal') return send(404, { error: 'not_found' }), true;
    return send(200, { resource: `${base}${resource}`, authorization_servers: [base], scopes_supported: ['mcp'], bearer_methods_supported: ['header'], resource_name: 'JUNCO desk' }), true;
  }
  if (req.method === 'GET' && (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration')) {
    return send(200, {
      issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, revocation_endpoint: `${base}/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp', 'offline_access'],
    }), true;
  }
  if (req.method === 'POST' && p === '/register') {
    let b: any; try { b = JSON.parse(await readRaw(req, 20_000)); } catch { return send(400, { error: 'invalid_client_metadata', error_description: 'JSON body required' }), true; }
    const uris = b?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(validRedirect)) return send(400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https, or http on localhost' }), true;
    const s = load(), id = `junco_${randomBytes(12).toString('base64url')}`, now = Date.now();
    const ids = Object.keys(s.clients); // ponytail: open registration capped by count, oldest out; add per-IP limits if it's abused
    if (ids.length >= MAX_CLIENTS) for (const k of ids.sort((a, z) => s.clients[a].at - s.clients[z].at).slice(0, ids.length - MAX_CLIENTS + 1)) delete s.clients[k];
    s.clients[id] = { redirect_uris: uris.map(String), name: String(b.client_name ?? 'an MCP client').slice(0, 80), at: now };
    save();
    return send(201, { client_id: id, client_id_issued_at: Math.floor(now / 1000), client_name: s.clients[id].name, redirect_uris: s.clients[id].redirect_uris,
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }), true;
  }
  if (p === '/authorize' && (req.method === 'GET' || req.method === 'POST')) {
    const form = req.method === 'POST' ? new URLSearchParams(await readRaw(req, 20_000)) : url.searchParams;
    const q = Object.fromEntries(PARAMS.map((k) => [k, form.get(k) ?? '']));
    const page = (code: number, html: string) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' }); res.end(html); };
    const client = load().clients[q.client_id];
    // Without a known client and a registered redirect there is nowhere safe to send an error, so it's shown here.
    if (!client) return page(400, '<p>Unknown client. Remove the connector in Claude and add it again.</p>'), true;
    if (!redirectOk(client.redirect_uris, q.redirect_uri)) return page(400, '<p>This redirect address was not registered by the client.</p>'), true;
    const back = (params: Record<string, string>) => { const u = new URL(q.redirect_uri); for (const [k, v] of Object.entries({ ...params, ...(q.state && { state: q.state }), iss: base })) u.searchParams.set(k, v); res.writeHead(302, { Location: u.toString(), 'Cache-Control': 'no-store' }); res.end(); };
    if (q.response_type !== 'code') return back({ error: 'unsupported_response_type' }), true;
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' }), true;
    if (req.method === 'GET') return page(200, loginPage(q, client.name)), true;
    const user = form.get('username') ?? '', pass = form.get('password') ?? '';
    const role: Role | null = process.env.OWNER_TOKEN && same(pass, process.env.OWNER_TOKEN) ? 'owner'
      : password && user.trim().toLowerCase() === 'judge' && same(pass, password) ? 'judge' : !password ? 'owner' : null;
    if (!role) { await new Promise((r) => setTimeout(r, 800)); return page(401, loginPage(q, client.name, 'That username and password did not match.')), true; }
    const code = mint();
    codes.set(code, { client_id: q.client_id, redirect_uri: q.redirect_uri, challenge: q.code_challenge, role, exp: Date.now() + CODE_MS });
    return back({ code }), true;
  }
  if (req.method === 'POST' && p === '/token') {
    const raw = await readRaw(req, 20_000);
    const f = String(req.headers['content-type'] ?? '').includes('json') ? new URLSearchParams(JSON.parse(raw || '{}')) : new URLSearchParams(raw);
    const s = load(), client_id = f.get('client_id') ?? '';
    if (!s.clients[client_id]) return send(401, { error: 'invalid_client', error_description: 'Unknown client; register again' }), true;
    const issue = (role: Role) => {
      const access = mint(), refresh = mint(), now = Date.now();
      s.tokens[hash(access)] = { kind: 'access', client_id, role, exp: now + ACCESS_S * 1000 };
      s.tokens[hash(refresh)] = { kind: 'refresh', client_id, role, exp: now + REFRESH_MS };
      save();
      send(200, { access_token: access, token_type: 'Bearer', expires_in: ACCESS_S, refresh_token: refresh, scope: 'mcp' });
    };
    const grant = f.get('grant_type');
    if (grant === 'authorization_code') {
      const c = codes.get(f.get('code') ?? ''); codes.delete(f.get('code') ?? ''); // single use, even when it fails
      if (!c || c.exp < Date.now() || c.client_id !== client_id || (f.get('redirect_uri') && f.get('redirect_uri') !== c.redirect_uri)) return send(400, { error: 'invalid_grant' }), true;
      if (!pkceOk(f.get('code_verifier') ?? '', c.challenge)) return send(400, { error: 'invalid_grant', error_description: 'PKCE check failed' }), true;
      return issue(c.role), true;
    }
    if (grant === 'refresh_token') { // rotated: the old refresh token dies with this answer
      const k = hash(f.get('refresh_token') ?? ''), t = s.tokens[k];
      if (!t || t.kind !== 'refresh' || t.client_id !== client_id || t.exp < Date.now()) return send(400, { error: 'invalid_grant' }), true;
      delete s.tokens[k];
      return issue(t.role), true;
    }
    return send(400, { error: 'unsupported_grant_type' }), true;
  }
  if (req.method === 'POST' && p === '/revoke') {
    const t = new URLSearchParams(await readRaw(req, 20_000)).get('token') ?? '';
    if (load().tokens[hash(t)]) { delete load().tokens[hash(t)]; save(); }
    return send(200, {}), true; // RFC 7009: the same answer whether or not the token existed
  }
  return false;
}

// Offline check: npx tsx src/oauth.ts
if (process.argv[1]?.endsWith('oauth.ts')) {
  const v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.ok(pkceOk(v, createHash('sha256').update(v).digest('base64url')));
  assert.ok(!pkceOk('other', createHash('sha256').update(v).digest('base64url')) && !pkceOk('', ''));
  assert.ok(redirectOk(['https://claude.ai/api/mcp/auth_callback'], 'https://claude.ai/api/mcp/auth_callback'));
  assert.ok(!redirectOk(['https://claude.ai/api/mcp/auth_callback'], 'https://evil.example/api/mcp/auth_callback'));
  assert.ok(redirectOk(['http://localhost:3118/callback'], 'http://127.0.0.1:50211/callback')); // loopback, any port
  assert.ok(!redirectOk(['http://localhost:3118/callback'], 'http://localhost:3118/other'));
  assert.ok(validRedirect('https://claude.ai/x') && validRedirect('http://localhost:1/x') && !validRedirect('http://evil.example/x') && !validRedirect('javascript:alert(1)'));
  console.log('oauth: PKCE S256 checked, redirects exact (loopback any port), only https or localhost registered');
}
