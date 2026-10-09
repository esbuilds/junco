// Carrier proof: look a tracking number up with the carrier itself (USPS APIs, developers.usps.com, OAuth 2.0
// client credentials). Evidence is labeled as carrier data only when the lookup succeeded; otherwise nothing is added
// and the merchant-typed scan stays the fallback ("entered by merchant"). Needs USPS_CONSUMER_KEY and
// USPS_CONSUMER_SECRET for an app with the Tracking product enabled (USPS grants it on request).
const BASE = process.env.USPS_API_BASE ?? 'https://apis.usps.com';

export type CarrierStatus = { number: string; status: string; delivered: boolean; at: string | null; place: string | null; source: string };

let token: { value: string; until: number } | null = null;
async function auth(): Promise<string | null> {
  const id = process.env.USPS_CONSUMER_KEY, secret = process.env.USPS_CONSUMER_SECRET;
  if (!id || !secret) return null;
  if (token && Date.now() < token.until) return token.value;
  const r = await fetch(`${BASE}/oauth2/v3/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: 'tracking' }),
  });
  if (!r.ok) throw new Error(`USPS token ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const b: any = await r.json();
  token = { value: b.access_token, until: Date.now() + (Number(b.expires_in ?? 3600) - 120) * 1000 };
  return token.value;
}

// Pure: the carrier's latest event as one status. check-carrier pins the parsing on a recorded response.
export function readUsps(number: string, body: any): CarrierStatus | null {
  const events: any[] = body?.trackingEvents ?? [];
  const last = events[0]; // USPS lists newest first
  const status = String(body?.statusCategory ?? body?.status ?? last?.eventType ?? '').trim();
  if (!status) return null;
  const delivered = /deliver/i.test(String(body?.statusCategory ?? '')) || /^delivered/i.test(String(last?.eventType ?? ''));
  const place = last ? [last.eventCity, last.eventState, last.eventZIP].filter(Boolean).join(' ') || null : null;
  return { number, status, delivered, at: last?.eventTimestamp ?? null, place, source: 'USPS tracking (carrier API)' };
}

const cache = new Map<string, { at: number; v: CarrierStatus | null }>();
// Returns null when there are no credentials, the carrier has no record, or the lookup failed: never a guess.
export async function lookupUsps(number: string): Promise<CarrierStatus | null> {
  const hit = cache.get(number);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.v; // ponytail: 30-minute in-memory cache, keeps us inside USPS quotas
  try {
    const t = await auth();
    if (!t) return null;
    const r = await fetch(`${BASE}/tracking/v3/tracking/${encodeURIComponent(number)}?expand=DETAIL`, { headers: { Authorization: `Bearer ${t}` } });
    const v = r.ok ? readUsps(number, await r.json()) : null;
    if (!r.ok) console.warn(`[carrier] USPS ${r.status} for ${number}`);
    cache.set(number, { at: Date.now(), v });
    return v;
  } catch (e: any) {
    console.warn('[carrier]', e.message);
    return null;
  }
}

export const carrierText = (c: CarrierStatus) => `${c.status}${c.place ? `, ${c.place}` : ''}${c.at ? `, ${c.at}` : ''} (tracking ${c.number}, looked up with USPS).`;
