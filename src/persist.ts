// Optional Postgres backing for .junco/*.json, for hosts with a throwaway disk (Render free tier).
// The JSON files stay the working copy: hydrate() restores them at startup, mirror() saves each write.
// ponytail: one row per file, last write wins; fine for one desk process, not for several writers.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url, max: 2, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: true } }) : null;
let queue: Promise<unknown> = Promise.resolve();

export async function hydrate() {
  if (!pool) return 0;
  await pool.query('create table if not exists junco_state (file text primary key, body jsonb not null, updated_at timestamptz not null default now())');
  const { rows } = await pool.query<{ file: string; body: unknown }>('select file, body from junco_state');
  for (const r of rows) { mkdirSync(dirname(r.file), { recursive: true }); writeFileSync(r.file, JSON.stringify(r.body, null, 2)); }
  return rows.length;
}

// Writes are queued so they land in order; a failed save is logged, and the next write of that file repairs it.
export function mirror(file: string, body: unknown) {
  if (!pool) return;
  queue = queue
    .then(() => pool.query('insert into junco_state (file, body) values ($1, $2) on conflict (file) do update set body = excluded.body, updated_at = now()', [file, JSON.stringify(body)]))
    .catch((e) => console.error('[persist] save failed', file, e.message));
}

export const flush = () => queue;
export const persistent = () => pool !== null;
