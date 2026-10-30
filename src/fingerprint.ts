// Mandate fingerprint (Oct 29): the first 12 hex of sha256 over a canonical JSON of what the buyer allowed the agent to do.
// The shopping agent writes it into PayPal's order at capture: custom_id "junco:m:<fp>" and invoice_id "JUNCO-M-<fp>-<minute>".
// The store's record keeps the same inputs, so the fingerprint can be recomputed and compared with PayPal's copy. It is a
// reference PayPal stored at capture, not a signature. Pure: no PayPal, no files, so check-fingerprint runs offline.
import { createHash } from 'node:crypto';

// at: when the mandate was set, before PayPal was called; model: the agent's model id.
export type Mandate = { instruction: string; budget: string; model: string; at: string };
// What the store keeps beside an agent order; paypal is PayPal's copy as read (at capture, or live on a dispute).
export type FingerprintRecord = { model: string; at: string; fingerprint: string; paypal?: { custom_id?: string; invoice_id?: string; read_at: string } };
export type Stored = { instruction: string; budget: string; mandate?: FingerprintRecord };

export function fingerprint(m: Mandate): string {
  const canonical = JSON.stringify({ at: m.at, budget: m.budget, instruction: m.instruction, model: m.model }); // keys sorted, always
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export type Check = { verdict: 'match' | 'mismatch' | 'not recorded' | 'before fingerprints'; text: string };
// PayPal's custom_id (passed in: the copy read now, or the one kept at capture) against the fingerprint the store's record
// reproduces. Older orders have no mandate and are never a mismatch.
export function checkAgainstPayPal(r: Stored, paypalCustomId: string | undefined): Check {
  const m = r.mandate;
  if (!m) return { verdict: 'before fingerprints', text: 'Not recorded at PayPal (placed before fingerprints).' };
  const got = paypalCustomId?.match(/^junco:m:([0-9a-f]{12})$/)?.[1];
  if (!got) return { verdict: 'not recorded', text: "Not recorded at PayPal: PayPal's copy of this payment carries no fingerprint." };
  const want = fingerprint({ instruction: r.instruction, budget: r.budget, model: m.model, at: m.at });
  if (got !== want) return { verdict: 'mismatch', text: `PayPal's record of this payment carries fingerprint ${got}. The store's record does not reproduce it, so it doesn't match.` };
  return { verdict: 'match', text: `PayPal's record of this payment carries the fingerprint of what the buyer allowed, written at capture, before any dispute. The store's record reproduces it (${got}).` };
}
