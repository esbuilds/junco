// "Try the brain": scenario mode. Runs the production recommender and validator on a synthetic case, either one of the
// eval scenarios or one a visitor writes. No PayPal calls, no holds, nothing saved. Each run is a Claude call, so it
// is rate-limited per visitor and per day.
import { decide } from './recommend.js';
import { scenarios, build, type Scenario } from '../evals/scenarios.js';

const PER_VISITOR_HOUR = 8, PER_DAY = 150;
const seen = new Map<string, number[]>();
let day = { date: '', count: 0 };

export function allow(visitor: string): string | null {
  const now = Date.now(), today = new Date().toISOString().slice(0, 10);
  if (day.date !== today) day = { date: today, count: 0 };
  if (day.count >= PER_DAY) return 'Scenario mode has hit its daily limit. Try again tomorrow.';
  const recent = (seen.get(visitor) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= PER_VISITOR_HOUR) return `Limit is ${PER_VISITOR_HOUR} runs an hour. Try again a bit later.`;
  seen.set(visitor, [...recent, now]); day.count++;
  return null;
}

export const listScenarios = () => scenarios.map((s) => ({ id: s.id, tag: s.tag, why: s.why }));

const INR = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', SNAD = 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED';
// A visitor's own case: one buyer message, the tracking situation, an optional delivery scan. Bounded inputs only.
export function customScenario(b: any): Scenario | string {
  const message = String(b?.message ?? '').trim().slice(0, 600);
  if (!message) return 'Write what the buyer says.';
  const amount = Number(b?.amount ?? 48);
  if (!(amount >= 1 && amount <= 2000)) return 'Amount must be between 1 and 2000.';
  const tracking = ['none', 'shipped', 'cancelled'].includes(b?.tracking) ? b.tracking : 'none';
  const scan = String(b?.scan ?? '').trim().slice(0, 200);
  return {
    id: 'custom', tag: 'custom', why: 'Written by a visitor',
    reason: b?.reason === 'snad' ? SNAD : INR, amount: amount.toFixed(2),
    status: 'WAITING_FOR_SELLER_RESPONSE', stage: 'INQUIRY', allowed: ['accept_claim', 'make_offer', 'send_message', 'provide_evidence', 'escalate'],
    trackers: tracking === 'none' ? [] : [['9400100000000000099999', tracking === 'shipped' ? 'SHIPPED' : 'CANCELLED']],
    records: scan ? [['carrier delivery scan (entered by merchant)', scan]] : [],
    messages: [['BUYER', message]], ok: [],
  };
}

export async function runTry(b: any) {
  const s = b?.scenario_id ? scenarios.find((x) => x.id === b.scenario_id) : customScenario(b);
  if (!s) return { error: 'Unknown scenario' };
  if (typeof s === 'string') return { error: s };
  const { dispute, evidence } = build(s);
  const out = await decide(dispute, evidence);
  return {
    scenario: { id: s.id, why: s.why, expected: s.ok, never: s.never ?? [] },
    recommendation: out.recommendation, problems: out.problems, evidence,
  };
}
