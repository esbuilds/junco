// THE BOOKS (Oct 30): every AI purchase on one row, what PayPal says beside what the desk recorded, with differences pinned
// first. Each row is reconciled() and threeRecords() on its incident, so the Books can't disagree with the incident page.
// PayPal is read through reconcile's cache, a few at a time, and a failed read comes back as unread. The replay column is
// decide() on the recorded moves under today's policy, so it reaches no PayPal. listIncidents() runs as the viewer, so a
// visitor's private purchase lists only for them and the owner. PayPal's GET comes from the desk; this file holds no client.
import { byDifference, threeRecords } from './incident-questions.js';
import type { BooksRow, Incident } from './incident-types.js';
import { buildIncident, listIncidents, reconciled, replay } from './incident.js';
import type { PayPalGet } from './reconcile.js';

const READS_AT_ONCE = 4; // ponytail: a cold page is purchases / 4 of about 1.3 s each; a queue if the books ever reach hundreds
const FINGERPRINT = { fingerprint_match: 'Match', fingerprint_mismatch: 'Mismatch', fingerprint_none: 'Not recorded' } as const;

export function bookRow(inc: Incident, at: string): BooksRow {
  const read = inc.events.find((e) => e.id === 'reconciliation:read'), status = read?.ref?.payment_status;
  const lines = inc.events.filter((e) => e.kind === 'reconciliation' && e !== read), fp = inc.events.find((e) => e.kind === 'paypal_fingerprint');
  const paidBack = lines.filter((e) => e.match === 'matched' || e.match === 'settled' || e.match === 'paypal_only').map((e) => e.ref?.amount).join(', ');
  const held = lines.find((e) => e.match === 'dispute_hold')?.ref?.amount, records = threeRecords(inc);
  const moves = inc.events.filter((e) => e.kind === 'hold' || e.kind === 'gate').flatMap((e) => replay(e.id) ?? []);
  return {
    purchase: inc.id, title: inc.title, at, paid: parseFloat(inc.purchase!.amount), paypal_status: status ?? 'Unread',
    refunds: !status ? 'Unread' : `${paidBack || 'None'}${held ? ` (dispute hold ${held})` : ''}`,
    holds: inc.events.filter((e) => e.kind === 'hold').length,
    fingerprint: !fp ? 'Before fingerprints' : FINGERPRINT[fp.match as keyof typeof FINGERPRINT] ?? 'Not read',
    reconciliation: records?.agree === false ? 'Differ' : records?.agree ? 'Agree' : 'Unread', line: records?.line ?? '',
    replay: !moves.length ? 'No moves' : moves.some((m) => m.before !== m.after) ? 'Changed today' : 'Same today',
    replay_detail: moves.map((m) => `${m.method.replace(/_/g, ' ')}: ${m.before} then, ${m.after} today.`).join(' ') || 'No money moves to re-run.',
  };
}

export async function books(get: PayPalGet): Promise<BooksRow[]> {
  const list = listIncidents(), rows: BooksRow[] = [];
  let next = 0;
  const reader = async () => {
    while (next < list.length) {
      const i = list[next++], inc = await reconciled(buildIncident(i.id), get);
      if (inc?.purchase) rows.push(bookRow(inc, i.last_at));
    }
  };
  await Promise.all(Array.from({ length: READS_AT_ONCE }, reader));
  return rows.sort(byDifference);
}
