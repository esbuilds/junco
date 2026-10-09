// Carrier proof: look a tracking number up with the carrier itself: USPS APIs (developers.usps.com) or UPS
// (developer.ups.com, for 1Z numbers), both OAuth 2.0 client credentials. Evidence is labeled as carrier data only when the lookup succeeded; otherwise nothing is added
// and the merchant-typed scan stays the fallback ("entered by merchant"). USPS needs USPS_CONSUMER_KEY/SECRET for an app
// with the Tracking product enabled (USPS grants it on request); UPS needs UPS_CLIENT_ID/SECRET with Tracking added.
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

export const carrierText = (c: CarrierStatus) => `${c.status}${c.place ? `, ${c.place}` : ''}${c.at ? `, ${c.at}` : ''} (tracking ${c.number}, looked up with ${c.source.split(' ')[0]}).`;

// UPS: field casing differs between UPS's older JSON and its current API, so both are read.
const UPS_BASE = process.env.UPS_API_BASE ?? 'https://onlinetools.ups.com';
let upsToken: { value: string; until: number } | null = null;
async function upsAuth(): Promise<string | null> {
  const id = process.env.UPS_CLIENT_ID, secret = process.env.UPS_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (upsToken && Date.now() < upsToken.until) return upsToken.value;
  const r = await fetch(`${UPS_BASE}/security/v1/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`UPS token ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const b: any = await r.json();
  upsToken = { value: b.access_token, until: Date.now() + (Number(b.expires_in ?? 3600) - 300) * 1000 };
  return upsToken.value;
}

const pick = (o: any, ...keys: string[]) => { for (const k of keys) if (o?.[k] !== undefined) return o[k]; return undefined; };
const first = (v: any) => (Array.isArray(v) ? v[0] : v);
export function readUps(number: string, body: any): CarrierStatus | null {
  const tr = pick(body, 'trackResponse', 'TrackResponse');
  const pkg = first(pick(first(pick(tr, 'shipment', 'Shipment')), 'package', 'Package'));
  const acts: any[] = [].concat(pick(pkg, 'activity', 'Activity') ?? []);
  const last = acts[0];
  const st = pick(last, 'status', 'Status');
  const current = pick(pkg, 'currentStatus', 'CurrentStatus');
  const status = String(pick(current, 'description', 'Description') ?? pick(st, 'description', 'Description') ?? '').trim();
  if (!status) return null;
  const loc = pick(last, 'location', 'ActivityLocation');
  const addr = pick(loc, 'address', 'Address') ?? loc;
  const place = addr ? [pick(addr, 'city', 'City'), pick(addr, 'stateProvince', 'StateProvinceCode'), pick(addr, 'postalCode', 'PostalCode')].filter(Boolean).join(' ') || null : null;
  const d = String(pick(last, 'date', 'Date') ?? ''), t = String(pick(last, 'time', 'Time') ?? '');
  const at = d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}${t.length >= 4 ? `T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6) || '00'}` : ''}` : null;
  const delivered = /deliver/i.test(status) || pick(st, 'type', 'Type') === 'D';
  return { number, status, delivered, at, place, source: 'UPS tracking (carrier API)' };
}

async function lookupUpsRaw(number: string): Promise<CarrierStatus | null> {
  const t = await upsAuth();
  if (!t) return null;
  const r = await fetch(`${UPS_BASE}/api/track/v1/details/${encodeURIComponent(number)}?locale=en_US&returnSignature=false`, {
    headers: { Authorization: `Bearer ${t}`, transId: crypto.randomUUID().slice(0, 32), transactionSrc: 'dispute-evidence' },
  });
  if (!r.ok) { console.warn(`[carrier] UPS ${r.status} for ${number}`); return null; }
  return readUps(number, await r.json());
}

// Pick the carrier from the number: UPS numbers start with 1Z; everything else goes to USPS.
export const isUps = (n: string) => /^1Z[0-9A-Z]{16}$/i.test(n);
export async function lookupCarrier(number: string): Promise<CarrierStatus | null> {
  if (!isUps(number)) return lookupUsps(number);
  const hit = cache.get(number);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.v;
  try { const v = await lookupUpsRaw(number); cache.set(number, { at: Date.now(), v }); return v; }
  catch (e: any) { console.warn('[carrier]', e.message); return null; }
}
