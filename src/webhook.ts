// Register (or list) the PayPal sandbox webhook that wakes the agent.
//   npm run webhook                 list this app's webhooks
//   npm run webhook <desk_url>      register <desk_url>/webhooks/paypal for dispute events
import { paypal } from './disputes.js';
import { sandboxCtx } from './server.js';

const ctx = await sandboxCtx();
const base = process.argv[2];
if (base) {
  const url = `${base.replace(/\/$/, '')}/webhooks/paypal`;
  const r = await paypal(ctx, 'POST', '/v1/notifications/webhooks', { json: {
    url, event_types: ['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED'].map((name) => ({ name })),
  } });
  console.log(r.status < 300 ? `Registered ${r.body.id} -> ${url}` : `Failed (${r.status}): ${JSON.stringify(r.body)}`);
}
const list = await paypal(ctx, 'GET', '/v1/notifications/webhooks');
for (const w of list.body.webhooks ?? []) console.log(`${w.id}  ${w.url}  ${w.event_types.map((e: any) => e.name).join(', ')}`);
