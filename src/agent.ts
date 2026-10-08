// Agent mode: JUNCO triages disputes on its own when PayPal reports them, acting through the same gate as everyone else.
// Allowed actions run, money-moving ones wait for the owner, and every step is logged.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { paypal, type Ctx } from './disputes.js';
import { recommend, gatherFromPayPal, type Recommendation } from './recommend.js';

type CallTool = (name: string, args: any) => Promise<any>;
export type Saved = { recommendation: Recommendation | null; problems: string[]; at: string };
export type Activity = { at: string; dispute_id: string; trigger: string; step: string; detail: string };

// ponytail: state in JSON files under .junco/; one desk process writes them. Use a DB if that ever changes.
const read = <T>(f: string, empty: T): T => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return empty; } };
const write = (f: string, v: unknown) => { mkdirSync('.junco', { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 2)); };
export const readRecs = () => read<Record<string, Saved>>('.junco/recs.json', {});
export const saveRec = (id: string, r: Saved) => write('.junco/recs.json', { ...readRecs(), [id]: r });
export const readActivity = () => read<Activity[]>('.junco/activity.json', []);
const handled = () => read<Record<string, { state: string; acted_at?: string }>>('.junco/handled.json', {});

export const allowedOf = (d: any): string[] => (d.links ?? []).map((l: any) => l.rel).filter((r: string) => r !== 'self');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeAgent(ctx: Ctx, callTool: CallTool, opts: { unlockWaitMs?: number; unlockTries?: number } = {}) {
  const getDispute = async (id: string) => {
    const r = await paypal(ctx, 'GET', `/v1/customer/disputes/${encodeURIComponent(id)}`);
    if (r.status !== 200) throw Object.assign(new Error(`PayPal ${r.status} loading ${id}`), { code: r.status });
    return r.body;
  };

  const log = (dispute_id: string, trigger: string, step: string, detail: string) => {
    const entry = { at: new Date().toISOString(), dispute_id, trigger, step, detail };
    write('.junco/activity.json', [...readActivity(), entry].slice(-500));
    console.log(`[agent] ${dispute_id} ${step}: ${detail}`);
  };

  // Recommendation -> one gated tool call. Contest uses the tracking PayPal already has on the order.
  async function act(id: string, rec: Recommendation, message?: string, actor = 'owner') {
    if (rec.decision === 'wait') return { error: { message: 'JUNCO recommends no PayPal action right now' } };
    if (rec.decision === 'message') return callTool('send_dispute_message', { dispute_id: id, message: message ?? rec.message_to_buyer });
    const d = await getDispute(id);
    if (rec.decision === 'offer')
      return callTool('make_dispute_offer', { dispute_id: id, offer_type: 'REFUND', offer_amount: { currency_code: d.dispute_amount.currency_code, value: rec.offer_amount }, note: message ?? rec.message_to_buyer ?? rec.summary });
    // ponytail: stock accept_dispute_claim rejects notes with spaces (toolkit 1.11 bug, see PLAN.md), so the note is one token
    if (rec.decision === 'accept') return callTool('accept_dispute_claim', { dispute_id: id, note: `accepted_via_junco_${actor}` });
    if (!allowedOf(d).includes('provide_evidence')) // under PayPal review: supporting info is the only way to make the case
      return callTool('provide_dispute_supporting_info', { dispute_id: id, notes: [rec.summary, ...rec.claims.map((c) => c.text)].join(' ').slice(0, 2000) });
    const tracker = (await gatherFromPayPal(ctx, d)).map((e) => e.text.match(/^Tracking (\S+) status SHIPPED/)?.[1]).find(Boolean);
    if (rec.evidence_type === 'PROOF_OF_FULFILLMENT' && !tracker) return { error: { message: 'No shipped tracking on the PayPal order to submit as proof of fulfillment' } };
    return callTool('provide_dispute_evidence', {
      dispute_id: id, evidence_type: rec.evidence_type ?? 'OTHER', notes: rec.summary,
      ...(tracker && { carrier_name: 'USPS', tracking_number: tracker }), // ponytail: carrier hardcoded until trackers expose it
    });
  }

  const busy = new Set<string>();
  async function triage(id: string, trigger: string) {
    if (busy.has(id)) return; // one run per dispute at a time; webhooks often arrive in bursts
    busy.add(id);
    try {
      let d = await getDispute(id);
      // New disputes list no merchant actions for a few minutes. Wait for PayPal instead of recommending "wait".
      for (let i = 0; !allowedOf(d).length && i < (opts.unlockTries ?? 10); i++) {
        if (i === 0) log(id, trigger, 'waiting', 'PayPal has not unlocked merchant actions yet');
        await sleep(opts.unlockWaitMs ?? 60_000);
        d = await getDispute(id);
      }
      const state = `${d.status}|${allowedOf(d).sort().join(',')}|${(d.messages ?? []).length}|${(d.evidences ?? []).length}`;
      const prev = handled()[id];
      if (prev?.state === state) return; // nothing changed since the agent last looked, including our own updates
      if (d.status === 'RESOLVED') { write('.junco/handled.json', { ...handled(), [id]: { state } }); return log(id, trigger, 'closed', `Resolved: ${d.dispute_outcome?.outcome_code ?? 'unknown outcome'}`); }

      const out = await recommend(ctx, id);
      saveRec(id, { recommendation: out.recommendation, problems: out.problems, at: new Date().toISOString() });
      const rec = out.recommendation;
      write('.junco/handled.json', { ...handled(), [id]: { ...prev, state } });
      if (!rec) return log(id, trigger, 'needs you', out.problems.join('; '));
      if (out.problems.length) return log(id, trigger, 'needs you', `Recommended ${rec.decision} but it failed checks: ${out.problems.join('; ')}`);
      if (rec.decision === 'wait') return log(id, trigger, 'no action', rec.summary);

      // Loop guard: never message a buyer who hasn't answered our last message.
      const lastMsg = (d.messages ?? []).at(-1);
      if (rec.decision === 'message' && lastMsg?.posted_by === 'SELLER')
        return log(id, trigger, 'no action', 'Already waiting on the buyer to reply to the last seller message');

      const r = await act(id, rec, undefined, 'agent');
      write('.junco/handled.json', { ...handled(), [id]: { state, acted_at: new Date().toISOString() } });
      if (r.held) log(id, trigger, 'waiting for you', `${rec.decision}: ${r.reason}`);
      else if (r.ok) log(id, trigger, 'done', `${rec.decision} sent to PayPal. ${rec.summary}`);
      else log(id, trigger, 'failed', `${rec.decision}: ${r.error?.message ?? JSON.stringify(r)}`);
      // Our own action changes the dispute; record the new state so the UPDATED webhook it causes is a no-op.
      const after = await getDispute(id);
      write('.junco/handled.json', { ...handled(), [id]: { state: `${after.status}|${allowedOf(after).sort().join(',')}|${(after.messages ?? []).length}|${(after.evidences ?? []).length}`, acted_at: new Date().toISOString() } });
    } catch (e: any) {
      log(id, trigger, 'failed', e.message);
    } finally {
      busy.delete(id);
    }
  }

  // Safety net for missed webhooks: pick up any open dispute the agent has never seen.
  async function sweep() {
    const list = await paypal(ctx, 'GET', '/v1/customer/disputes?page_size=50');
    const seen = handled();
    for (const item of list.body.items ?? []) if (!seen[item.dispute_id] && item.status !== 'RESOLVED') await triage(item.dispute_id, 'sweep');
  }

  // Verify a webhook with PayPal before trusting it; each triage can cost a Claude call.
  let webhookId: string | undefined = process.env.PAYPAL_WEBHOOK_ID;
  async function verifyWebhook(headers: Record<string, string | string[] | undefined>, event: any, url: string) {
    if (!webhookId) { // find our own webhook registration by URL so no extra config is needed
      const r = await paypal(ctx, 'GET', '/v1/notifications/webhooks');
      webhookId = (r.body.webhooks ?? []).find((w: any) => w.url === url)?.id;
      if (!webhookId) return false;
    }
    const h = (k: string) => String(headers[k] ?? '');
    const r = await paypal(ctx, 'POST', '/v1/notifications/verify-webhook-signature', { json: {
      auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'),
      webhook_id: webhookId, webhook_event: event,
    } });
    return r.body.verification_status === 'SUCCESS';
  }

  return { act, triage, sweep, verifyWebhook, getDispute };
}
