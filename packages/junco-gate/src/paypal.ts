// PayPal dispute hooks for gate(): a hold snapshots the case the owner is shown; approval re-reads it and refuses (stale)
// if it moved on; an unknown outcome is settled by comparing a re-read with what the case looked like before the call.
// readDispute can be anything that returns PayPal's dispute JSON: the REST API, or the hosted MCP server's get_dispute.
import type { GateOptions, Hold } from './index.js';

// PayPal link rel each dispute write needs.
const REL: Record<string, string> = {
  accept_dispute_claim: 'accept_claim', make_dispute_offer: 'make_offer', send_dispute_message: 'send_message',
  provide_dispute_evidence: 'provide_evidence', provide_dispute_supporting_info: 'provide_supporting_info',
};
export type CaseState = { stage: string; amount: string };
export const caseState = (d: any): CaseState => ({ stage: d.dispute_life_cycle_stage, amount: `${d.dispute_amount?.value} ${d.dispute_amount?.currency_code}` });

// Why an approval must not run now, or null. The owner approved the case as it was when held; a case that moved on needs asking again.
export function staleReason(h: Pick<Hold, 'method'> & { case?: CaseState }, d: any): string | null {
  if (d.status === 'RESOLVED') return `the case is already resolved`;
  const now = caseState(d);
  if (h.case && h.case.stage !== now.stage) return `the case moved from ${h.case.stage} to ${now.stage} since this was held`;
  if (h.case && h.case.amount !== now.amount) return `the disputed amount changed from ${h.case.amount} to ${now.amount} since this was held`;
  const rel = REL[h.method];
  if (rel && !(d.links ?? []).some((l: any) => l.rel === rel)) return `PayPal no longer allows ${rel} on this case`;
  return null;
}

// What a write leaves on the case, read before it runs. If the call's outcome is unknown, a re-read compares against it.
export type Trail = { status: string; messages: number; evidences: number; info: number; offers: number; rels: string[] };
export const trail = (d: any): Trail => ({ status: d.status, messages: d.messages?.length ?? 0, evidences: d.evidences?.length ?? 0,
  info: d.supporting_info?.length ?? 0, offers: d.offer?.history?.length ?? 0, rels: (d.links ?? []).map((l: any) => l.rel) });
// Did this write land? true / false from the re-read, null when the method leaves nothing on the case we can compare.
export function landed(method: string, before: Trail, d: any): boolean | null {
  const now = trail(d);
  switch (method) {
    case 'accept_dispute_claim': return now.status === 'RESOLVED' || now.status !== before.status || !now.rels.includes('accept_claim');
    case 'send_dispute_message': return now.messages > before.messages;
    case 'make_dispute_offer': return now.offers > before.offers || now.status !== before.status;
    case 'provide_dispute_evidence': return now.evidences > before.evidences;
    case 'provide_dispute_supporting_info': return now.info > before.info;
    default: return null;
  }
}

// The hooks, for any call whose args name a dispute_id.
export function paypalDisputeHooks(readDispute: (id: string) => Promise<any>): Pick<GateOptions, 'snapshot' | 'beforeRun' | 'landed' | 'unknownErrors'> {
  const read = (h: Hold) => (h.args?.dispute_id ? readDispute(h.args.dispute_id) : null);
  return {
    snapshot: async (h) => { const d = await read(h); return d ? caseState(d) : undefined; },
    beforeRun: async (h) => { const d = await read(h); return d ? { refuse: staleReason(h, d), trail: trail(d) } : {}; },
    landed: async (h) => { const d = h.before ? await read(h)?.catch(() => null) : null; return d ? landed(h.method, h.before, d) : null; },
    unknownErrors: ['hosted_unavailable', 'upstream_unavailable'],
  };
}

// A client-credentials token for PayPal's hosted MCP server (it accepts one; verified Oct 9 2026 on the sandbox).
export async function paypalToken(id: string, secret: string, sandbox = true) {
  const r = await fetch(`https://api-m.${sandbox ? 'sandbox.' : ''}paypal.com/v1/oauth2/token`, {
    method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!r.ok) throw new Error(`PayPal token request failed: ${r.status}`);
  const b = (await r.json()) as { access_token: string; expires_in: number };
  return { token: b.access_token, expiresIn: b.expires_in };
}
