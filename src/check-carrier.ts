// Carrier check. Offline: parses a recorded USPS-shaped response. Live (needs USPS_CONSUMER_KEY/SECRET with Tracking
// enabled): npm run check-carrier -- <tracking number>  prints what the carrier returns and what JUNCO would cite.
import assert from 'node:assert/strict';
import { readUsps, readUps, isUps, lookupCarrier, carrierText } from './carrier.js';

try { process.loadEnvFile(); } catch {}
const delivered = readUsps('9400111899223344556677', { statusCategory: 'Delivered', trackingEvents: [
  { eventType: 'Delivered, Front Door/Porch', eventTimestamp: '2026-10-10T14:41:00', eventCity: 'SAN JOSE', eventState: 'CA', eventZIP: '95131' },
  { eventType: 'Out for Delivery', eventTimestamp: '2026-10-10T08:02:00', eventCity: 'SAN JOSE', eventState: 'CA', eventZIP: '95131' } ] });
assert.equal(delivered?.delivered, true);
assert.equal(delivered?.place, 'SAN JOSE CA 95131');
assert.equal(delivered?.at, '2026-10-10T14:41:00');
assert.equal(readUsps('x', { statusCategory: 'In Transit', trackingEvents: [{ eventType: 'Arrived at USPS Facility' }] })?.delivered, false);
assert.equal(readUsps('x', {}), null); // nothing from the carrier: no evidence, never a guess
const upsNew = readUps('1Z999AA10123456784', { trackResponse: { shipment: [{ package: [{ currentStatus: { description: 'Delivered' }, activity: [{ location: { address: { city: 'SAN JOSE', stateProvince: 'CA', postalCode: '95131' } }, status: { type: 'D', description: 'DELIVERED' }, date: '20261010', time: '144100' }] }] }] } });
assert.deepEqual([upsNew?.delivered, upsNew?.place, upsNew?.at], [true, 'SAN JOSE CA 95131', '2026-10-10T14:41:00']);
const upsOld = readUps('1Z999AA10123456784', { TrackResponse: { Shipment: { Package: { Activity: [{ ActivityLocation: { Address: { City: 'SAN JOSE', StateProvinceCode: 'CA', PostalCode: '95131' } }, Status: { Type: 'I', Description: 'In Transit' }, Date: '20261009', Time: '0800' }] } } } });
assert.deepEqual([upsOld?.delivered, upsOld?.place, upsOld?.at], [false, 'SAN JOSE CA 95131', '2026-10-09T08:00:00']);
assert.equal(isUps('1Z999AA10123456784'), true);
assert.equal(isUps('9400111899223344556677'), false);
console.log('carrier parse: USPS delivered, in transit, empty; UPS current and older JSON; routing by number');

const n = process.argv[2];
if (!n) console.log('live lookup skipped: pass a tracking number (and set USPS_CONSUMER_KEY/SECRET)');
else if (!(isUps(n) ? process.env.UPS_CLIENT_ID : process.env.USPS_CONSUMER_KEY)) console.log(`live lookup skipped: ${isUps(n) ? 'UPS_CLIENT_ID/SECRET' : 'USPS_CONSUMER_KEY/SECRET'} not set`);
else { const c = await lookupCarrier(n); console.log(c ? carrierText(c) : 'The carrier returned nothing usable (no record, no tracking access, or an error above)'); }
