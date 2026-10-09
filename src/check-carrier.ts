// Carrier check. Offline: parses a recorded USPS-shaped response. Live (needs USPS_CONSUMER_KEY/SECRET with Tracking
// enabled): npm run check-carrier -- <tracking number>  prints what the carrier returns and what JUNCO would cite.
import assert from 'node:assert/strict';
import { readUsps, lookupUsps, carrierText } from './carrier.js';

try { process.loadEnvFile(); } catch {}
const delivered = readUsps('9400111899223344556677', { statusCategory: 'Delivered', trackingEvents: [
  { eventType: 'Delivered, Front Door/Porch', eventTimestamp: '2026-10-10T14:41:00', eventCity: 'SAN JOSE', eventState: 'CA', eventZIP: '95131' },
  { eventType: 'Out for Delivery', eventTimestamp: '2026-10-10T08:02:00', eventCity: 'SAN JOSE', eventState: 'CA', eventZIP: '95131' } ] });
assert.equal(delivered?.delivered, true);
assert.equal(delivered?.place, 'SAN JOSE CA 95131');
assert.equal(delivered?.at, '2026-10-10T14:41:00');
assert.equal(readUsps('x', { statusCategory: 'In Transit', trackingEvents: [{ eventType: 'Arrived at USPS Facility' }] })?.delivered, false);
assert.equal(readUsps('x', {}), null); // nothing from the carrier: no evidence, never a guess
console.log('carrier parse: delivered with place and time, in transit, empty response');

const n = process.argv[2];
if (!n) console.log('live lookup skipped: pass a tracking number (and set USPS_CONSUMER_KEY/SECRET)');
else if (!process.env.USPS_CONSUMER_KEY) console.log('live lookup skipped: USPS_CONSUMER_KEY/SECRET not set');
else { const c = await lookupUsps(n); console.log(c ? `USPS: ${carrierText(c)}` : 'USPS returned nothing usable (no record, no tracking access, or an error above)'); }
