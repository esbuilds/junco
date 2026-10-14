// Optional Postgres backing for .junco/*.json, for hosts whose disk is wiped on restart and redeploy (Render without a disk).
// The JSON files stay the working copy: hydrate() restores them at startup, mirror() saves each write.
// ponytail: one row per file, last write wins; fine for one desk process, not for several writers.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

// Read lazily: .env is loaded after imports run (sandboxCtx), and real env vars on hosts are already set.
let pool: pg.Pool | null | undefined;
const db = () => {
  if (pool !== undefined) return pool;
  const url = process.env.DATABASE_URL;
  // TLS for external hosts (e.g. *.render.com, Neon); none for localhost or Render's internal hostnames, which have no dots.
  const host = url ? new URL(url).hostname : '';
  const tls = host.includes('.') && host !== '127.0.0.1';
  pool = url ? new pg.Pool({ connectionString: url, max: 2, ssl: tls ? { rejectUnauthorized: true } : false }) : null;
  if (!pool && process.env.RENDER) console.warn('[persist] WARNING: no DATABASE_URL on Render. Holds, recommendations and agent state live on a disk Render wipes on every restart and redeploy.');
  return pool;
};
let queue: Promise<unknown> = Promise.resolve();

export async function hydrate() {
  const pool = db();
  if (!pool) return 0;
  await pool.query('create table if not exists junco_state (file text primary key, body jsonb not null, updated_at timestamptz not null default now())');
  const { rows } = await pool.query<{ file: string; body: unknown }>('select file, body from junco_state');
  for (const r of rows) { mkdirSync(dirname(r.file), { recursive: true }); writeFileSync(r.file, JSON.stringify(r.body, null, 2)); }
  return rows.length;
}

// Writes are queued so they land in order; a failed save is logged, and the next write of that file repairs it.
export function mirror(file: string, body: unknown) {
  const pool = db();
  if (!pool) return;
  queue = queue
    .then(() => pool.query('insert into junco_state (file, body) values ($1, $2) on conflict (file) do update set body = excluded.body, updated_at = now()', [file, JSON.stringify(body)]))
    .catch((e) => console.error('[persist] save failed', file, e.message));
}

export const flush = () => queue;
export const persistent = () => db() !== null;

// For the desk's self-check: null when no database is configured, else whether a trivial query answers.
export async function dbOk(): Promise<boolean | null> {
  const pool = db();
  if (!pool) return null;
  await pool.query('select 1');
  return true;
}
