// JUNCO dispute tools: the contest-side actions missing from @paypal/agent-toolkit.
// Same shape as the toolkit's own tools ({method, name, description, parameters, actions}).
import { z } from 'zod';

const DISPUTE_ID = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/, 'Invalid PayPal Dispute ID');
const MONEY = z.object({
  currency_code: z.string().length(3),
  value: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Amount like "10" or "10.00"'),
});

export type Ctx = { baseUrl: string; token: () => Promise<string> };

export const tools = [
  {
    method: 'provide_dispute_evidence',
    name: 'Provide dispute evidence',
    rel: 'provide_evidence',
    description: `Contest a PayPal dispute by submitting evidence for the merchant.
Use PROOF_OF_FULFILLMENT with carrier and tracking number when the item shipped. Only works when PayPal currently allows provide_evidence on the dispute.`,
    parameters: z.object({
      dispute_id: DISPUTE_ID,
      evidence_type: z.enum(['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER']),
      carrier_name: z.string().optional().describe('Required for PROOF_OF_FULFILLMENT, e.g. USPS, UPS, FEDEX'),
      tracking_number: z.string().optional().describe('Required for PROOF_OF_FULFILLMENT'),
      refund_id: z.string().optional().describe('Required for PROOF_OF_REFUND'),
      notes: z.string().max(2000).describe('Short explanation for PayPal, citing the evidence'),
    }),
    actions: { disputes: { update: true } },
  },
  {
    method: 'make_dispute_offer',
    name: 'Make dispute offer',
    rel: 'make_offer',
    description: `Offer the buyer a resolution (usually a partial refund) to settle a dispute before it escalates. Moves money if the buyer accepts. Only works when PayPal currently allows make_offer.`,
    parameters: z.object({
      dispute_id: DISPUTE_ID,
      offer_type: z.enum(['REFUND', 'REFUND_WITH_RETURN', 'REFUND_WITH_REPLACEMENT', 'REPLACEMENT_WITHOUT_REFUND']),
      offer_amount: MONEY.optional().describe('Required unless REPLACEMENT_WITHOUT_REFUND'),
      note: z.string().max(2000).describe('Message to the buyer explaining the offer'),
    }),
    actions: { disputes: { update: true } },
  },
  {
    method: 'send_dispute_message',
    name: 'Send dispute message',
    rel: 'send_message',
    description: `Send the buyer a message on an open dispute, e.g. to share tracking or ask what went wrong. Only works when PayPal currently allows send_message.`,
    parameters: z.object({
      dispute_id: DISPUTE_ID,
      message: z.string().min(1).max(2000),
    }),
    actions: { disputes: { update: true } },
  },
] as const;

type Tool = (typeof tools)[number];

// Rules PayPal enforces only after a round trip, checked up front so the agent gets a clear reason.
export function checkArgs(method: string, a: any): string | null {
  if (method === 'provide_dispute_evidence') {
    if (a.evidence_type === 'PROOF_OF_FULFILLMENT' && !(a.carrier_name && a.tracking_number))
      return 'PROOF_OF_FULFILLMENT needs carrier_name and tracking_number';
    if (a.evidence_type === 'PROOF_OF_REFUND' && !a.refund_id) return 'PROOF_OF_REFUND needs refund_id';
  }
  if (method === 'make_dispute_offer' && a.offer_type !== 'REPLACEMENT_WITHOUT_REFUND' && !a.offer_amount)
    return `${a.offer_type} needs offer_amount`;
  return null;
}

export async function paypal(ctx: Ctx, method: string, path: string, init: { json?: unknown; form?: unknown } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${await ctx.token()}` };
  let body: BodyInit | undefined;
  if (init.form !== undefined) {
    // disputes write endpoints take multipart with a JSON part named `input`
    const fd = new FormData();
    fd.append('input', new Blob([JSON.stringify(init.form)], { type: 'application/json' }));
    body = fd;
  } else if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const r = await fetch(ctx.baseUrl + path, { method, headers, body });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

export async function run(ctx: Ctx, method: string, a: any): Promise<string> {
  const tool = tools.find((t) => t.method === method) as Tool | undefined;
  if (!tool) return JSON.stringify({ error: { message: `Unknown method ${method}` } });
  const parsed = tool.parameters.safeParse(a);
  if (!parsed.success) return JSON.stringify({ error: { message: parsed.error.issues.map((i) => i.message).join('; ') } });
  a = parsed.data;
  const bad = checkArgs(method, a);
  if (bad) return JSON.stringify({ error: { message: bad, type: 'invalid_arguments' } });

  // HATEOAS gate: act only if PayPal lists this action on the dispute right now.
  const d = await paypal(ctx, 'GET', `/v1/customer/disputes/${a.dispute_id}`);
  if (d.status !== 200) return JSON.stringify({ error: { message: `Could not load dispute (${d.status})`, details: d.body } });
  const allowed: string[] = (d.body.links ?? []).map((l: any) => l.rel);
  if (!allowed.includes(tool.rel))
    return JSON.stringify({
      error: { message: `PayPal does not allow ${tool.rel} on this dispute now`, type: 'action_not_allowed' },
      status: d.body.status, stage: d.body.dispute_life_cycle_stage, allowed_actions: allowed.filter((r) => r !== 'self'),
    });

  const base = `/v1/customer/disputes/${a.dispute_id}`;
  let res;
  if (method === 'provide_dispute_evidence') {
    const info: any = {};
    if (a.tracking_number) info.tracking_info = [{ carrier_name: a.carrier_name, tracking_number: a.tracking_number }];
    if (a.refund_id) info.refund_ids = [{ refund_id: a.refund_id }];
    res = await paypal(ctx, 'POST', `${base}/provide-evidence`, {
      form: { evidences: [{ evidence_type: a.evidence_type, evidence_info: info, notes: a.notes }] },
    });
  } else if (method === 'make_dispute_offer') {
    res = await paypal(ctx, 'POST', `${base}/make-offer`, {
      json: { note: a.note, offer_type: a.offer_type, ...(a.offer_amount && { offer_amount: a.offer_amount }) },
    });
  } else {
    res = await paypal(ctx, 'POST', `${base}/send-message`, { form: { message: a.message } });
  }
  return JSON.stringify(res.status < 300 ? { ok: true, status: res.status } : { error: { message: `PayPal ${res.status}`, details: res.body } });
}
