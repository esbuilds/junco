// Sets up a sandbox purchase to dispute. PayPal's buyer-side dispute API needs permissions this app doesn't have,
// so the buyer opens the dispute in the sandbox site (about 2 minutes, steps printed below).
//   npm run seed                      create an order, print the buyer approval link
//   npm run seed capture <order_id>   capture it and add USPS tracking   (scenario: shipped, worth contesting)
//   npm run seed capture <order_id> unshipped                      (scenario: never shipped, should concede)
import { paypal } from './disputes.js';
import { sandboxCtx } from './server.js';

const ctx = await sandboxCtx();
const [cmd, orderId] = process.argv.slice(2);

if (!cmd) {
  const r = await paypal(ctx, 'POST', '/v2/checkout/orders', { json: {
    intent: 'CAPTURE',
    purchase_units: [{
      amount: { currency_code: 'USD', value: '48.00', breakdown: { item_total: { currency_code: 'USD', value: '48.00' } } },
      items: [{ name: 'Canvas tote', quantity: '1', unit_amount: { currency_code: 'USD', value: '48.00' } }],
    }],
    payment_source: { paypal: { experience_context: { return_url: 'https://example.com/return', cancel_url: 'https://example.com/cancel' } } },
  } });
  if (r.status >= 300) { console.error('Order failed', r.status, JSON.stringify(r.body)); process.exit(1); }
  const approve = r.body.links?.find((l: any) => l.rel === 'payer-action')?.href;
  console.log(`Order ${r.body.id} created.

1. Open this link and log in as your sandbox PERSONAL (buyer) account, then pay:
   ${approve}
   (It redirects to example.com afterwards. That's expected.)
2. Run: npm run seed capture ${r.body.id}            (shipped, with tracking)
   or:  npm run seed capture ${r.body.id} unshipped     (never shipped)`);
} else if (cmd === 'capture' && orderId) {
  const r = await paypal(ctx, 'POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { json: {} });
  if (r.status >= 300) { console.error('Capture failed. Did the buyer approve the order?', r.status, JSON.stringify(r.body)); process.exit(1); }
  const capture = r.body.purchase_units?.[0]?.payments?.captures?.[0]?.id;
  console.log(`Captured ${capture}, paid by ${r.body.payer?.email_address}.`);
  if (!process.argv.slice(2).some((a) => a === 'unshipped' || a === '--no-tracking')) {
    const tracking = `9400${String(Date.now()).padStart(18, '0')}`; // ponytail: fake USPS-shaped number, sandbox only
    const t = await paypal(ctx, 'POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/track`, { json: { capture_id: capture, tracking_number: tracking, carrier: 'USPS', notify_payer: false } });
    console.log(t.status < 300 ? `Added USPS tracking ${tracking}.` : `Tracking failed (${t.status}): ${JSON.stringify(t.body)}`);
  } else console.log('No tracking added: this order never shipped.');
  console.log(`
3. Open the dispute as the buyer (about 2 minutes):
   - Go to https://www.sandbox.paypal.com and log in as ${r.body.payer?.email_address}
   - Activity -> the $48.00 Test Store payment -> Report a problem -> I didn't receive my item -> submit
4. Wait about 4 minutes for PayPal to unlock merchant actions, then refresh the dispute desk.`);
} else {
  console.log('usage: npm run seed | npm run seed capture <order_id> [unshipped]');
}
