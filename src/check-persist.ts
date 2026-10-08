// Persistence check: state written in one process survives losing the disk. Needs DATABASE_URL (a throwaway DB).
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

if (!process.env.DATABASE_URL) { console.log('skip: set DATABASE_URL to a throwaway Postgres database'); process.exit(0); }
const run = (code: string) => execFileSync('npx', ['tsx', '-e', `(async () => { ${code} })().catch((e) => { console.error(e); process.exit(1); })`], { encoding: 'utf8', env: process.env }).trim();

// Process 1: create a hold through the gated MCP server, then let the Postgres write finish.
const id = run(`
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createServer, sandboxCtx } = await import('./src/server.ts');
  const { flush } = await import('./src/persist.ts');
  const [a, b] = InMemoryTransport.createLinkedPair();
  const { server } = await createServer(await sandboxCtx());
  await server.connect(a);
  const c = new Client({ name: 'p', version: '0' }); await c.connect(b);
  const r = await c.callTool({ name: 'make_dispute_offer', arguments: { dispute_id: 'PP-R-ERP-10190210', offer_type: 'REFUND', offer_amount: { currency_code: 'USD', value: '40' }, note: 'persist check' } });
  await flush(); await c.close();
  console.log(JSON.parse(r.content[0].text).hold_id);
`).split('\n').at(-1)!;
assert.match(id, /^[0-9a-f]{8}$/, `expected a hold id, got ${id}`);

rmSync('.junco', { recursive: true, force: true }); // what Render does on restart
assert(!existsSync('.junco/holds.json'));

// Process 2: a fresh start restores the hold from Postgres, and the owner can still reject it.
const status = run(`
  const { createServer, sandboxCtx } = await import('./src/server.ts');
  const { readHolds } = await import('./src/gate.ts');
  const { flush } = await import('./src/persist.ts');
  const { holds } = await createServer(await sandboxCtx());
  const h = readHolds().find((x) => x.id === '${id}');
  console.log(h ? (await holds.reject(h.id)).status : 'missing');
  await flush();
`).split('\n').at(-1);
assert.equal(status, 'rejected', 'hold should survive a lost disk and still be actionable');
console.log(`hold ${id} survived a wiped .junco/ and was rejected after restart`);
console.log('ok');
