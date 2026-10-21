// Register (or list) the PayPal sandbox webhook that wakes the agent.
//   npm run webhook                 list this app's webhooks
//   npm run webhook <desk_url>      register <desk_url>/webhooks/paypal (or update its events if it exists)
import { paypal } from './disputes.js';
import { sandboxCtx } from './server.js';

// Dispute events wake the agent; captured payments feed Shipment watch; dispute events and refunds flag pending holds
// for re-check (a reported refund also refuses a held refund on the same payment).
const EVENTS = ['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.REFUNDED'].map((name) => ({ name }));
const ctx = await sandboxCtx();
const base = process.argv[2];
let list = await paypal(ctx, 'GET', '/v1/notifications/webhooks');
if (base) {
  const url = `${base.replace(/\/$/, '')}/webhooks/paypal`;
  const existing = (list.body.webhooks ?? []).find((w: any) => w.url === url);
  const r = existing
    ? await paypal(ctx, 'PATCH', `/v1/notifications/webhooks/${existing.id}`, { json: [{ op: 'replace', path: '/event_types', value: EVENTS }] })
    : await paypal(ctx, 'POST', '/v1/notifications/webhooks', { json: { url, event_types: EVENTS } });
  console.log(r.status < 300 ? `${existing ? 'Updated' : 'Registered'} ${r.body.id} -> ${url}` : `Failed (${r.status}): ${JSON.stringify(r.body)}`);
  list = await paypal(ctx, 'GET', '/v1/notifications/webhooks');
}
for (const w of list.body.webhooks ?? []) console.log(`${w.id}  ${w.url}  ${w.event_types.map((e: any) => e.name).join(', ')}`);
