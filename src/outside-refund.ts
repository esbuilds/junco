// OUTSIDE REFUND (Oct 30): PayPal's webhook says a payment was refunded, and the desk didn't do it. The verdict is
// reconciliation's (reconciled() in incident.ts), so the alert and the incident page can't disagree. A refund the desk ran
// can be reported before its hold stores PayPal's answer, so nothing is decided while a money hold on the purchase is
// executing or of unknown outcome, and the first read waits a moment for the gate log, which is written after the call.
// Reads only; the one write is this file's own record. It says PayPal reported the refund and never who made it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { MONEY, readHolds } from './gate.js';
import { buildIncident, reconciled } from './incident.js';
import { mirror } from './persist.js';
import { forget, type PayPalGet } from './reconcile.js';

export type OutsideRefund = { refund_id: string; capture_id: string; incident_id: string | null; amount: string; at: string };
const FILE = '.junco/outside-refunds.json';
export const readOutside = (): OutsideRefund[] => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return []; } };
const keep = (x: OutsideRefund) => { const all = [...readOutside(), x]; mkdirSync('.junco', { recursive: true }); writeFileSync(FILE, JSON.stringify(all, null, 2)); mirror(FILE, all); };
const known = (capture_id: string) => { try { return buildIncident(capture_id); } catch { return null; } }; // two purchases on one capture are never guessed between

const CHECKS = 4, EVERY = 15_000;
const working = new Set<string>(); // PayPal can deliver one event twice at once; the file only dedupes finished ones

type Deps = { get: PayPalGet; notify: (text: string) => void; desk: string; wait?: () => Promise<void> };
export async function outsideRefund(r: any, capture_id: string, { get, notify, desk, wait = () => new Promise((ok) => setTimeout(ok, EVERY)) }: Deps) {
  const refund_id = String(r.id);
  if (working.has(refund_id) || readOutside().some((x) => x.refund_id === refund_id)) return;
  working.add(refund_id);
  try {
    const amount = `${r.amount?.value} ${r.amount?.currency_code ?? 'USD'}`;
    const at = new Date(Date.parse(r.create_time) || Date.now()).toISOString(); // PayPal sends a local offset; incident events sort as UTC text
    const inc = known(capture_id);
    if (!inc) { keep({ refund_id, capture_id, incident_id: null, amount, at }); return console.log(`[outside refund] ${refund_id} for ${amount} on ${capture_id}: no purchase the desk knows`); }
    for (let i = 0; i < CHECKS; i++) {
      await wait();
      forget(capture_id);
      const now = await reconciled(known(capture_id), get);
      const running = readHolds().some((h) => MONEY.includes(h.method) && (h.status === 'executing' || h.status === 'unknown')
        && (h.args?.capture_id === capture_id || (!!inc.dispute_id && h.args?.dispute_id === inc.dispute_id)));
      const line = now?.events.find((e) => e.kind === 'reconciliation' && e.ref?.refund_id === refund_id);
      if (running || !line) continue;
      if (line.match !== 'paypal_only') return;
      keep({ refund_id, capture_id, incident_id: inc.id, amount, at });
      return notify(`PayPal reported a refund of ${amount} (${refund_id}) the desk didn't make.\n<${desk}/incident/${encodeURIComponent(inc.id)}|Open the incident>`);
    }
    // ponytail: gives up after a minute and a restart drops the wait; the refund still shows on the incident through reconciliation
    console.warn(`[outside refund] ${refund_id} on ${capture_id}: couldn't tell whose it is, so no alert`);
  } finally { working.delete(refund_id); }
}
