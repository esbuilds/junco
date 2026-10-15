// Fills the M1 pool: paid sandbox orders whose BUYER transaction ID is known, so "Dispute this store" can file live.
// Runs locally (needs the sandbox buyer's login, which never goes to the hosted desk):
//   npm run pool -- 5 delivered  five orders with USPS tracking plus a delivery record entered by the store (JUNCO should
//                                send supporting info); PayPal itself never marks a sandbox order delivered
//   npm run pool -- 5 unshipped  five orders with no tracking (JUNCO should hold an accept on these)
//   npm run pool -- 3 agent      orders a Claude shopping agent places for the buyer (src/shopper.ts), paid merchant-initiated
//                                with the PayPal account the buyer saved for the store (AGENT_VAULT_ID; made on first run),
//                                plus the store's delivery record; disputed later as not as described
// Needs SANDBOX_BUYER_EMAIL and SANDBOX_BUYER_PASSWORD in .env, plus OWNER_TOKEN (same value as on the desk).
// One order at a time; on a failed step it saves a screenshot to .junco/pool-fail.png and stops.
import { createRequire } from 'node:module';
import { paypal } from './disputes.js';
import { sandboxCtx } from './server.js';
import { AGENT_NAME, CATALOG, INSTRUCTIONS, listing, shop } from './shopper.js';

const { chromium } = createRequire(new URL('../studio/package.json', import.meta.url))('playwright');
const ctx = await sandboxCtx();
const [n = '1', kind = ''] = process.argv.slice(2);
if (!['delivered', 'unshipped', 'agent'].includes(kind)) { console.error('usage: npm run pool -- <n> delivered|unshipped|agent'); process.exit(1); }
const email = process.env.SANDBOX_BUYER_EMAIL, password = process.env.SANDBOX_BUYER_PASSWORD;
if (!email || !password) { console.error('Set SANDBOX_BUYER_EMAIL and SANDBOX_BUYER_PASSWORD in .env'); process.exit(1); }
const DESK = process.env.DESK_URL ?? 'https://junco-desk.onrender.com';
const SANDBOX = 'https://www.sandbox.paypal.com';

const browser = await chromium.launch();
const page = await browser.newPage();
const fail = async (what: string) => { await page.screenshot({ path: '.junco/pool-fail.png', fullPage: true }); console.error(`${what} failed at ${page.url()}; see .junco/pool-fail.png`); await browser.close(); process.exit(1); };

// Log in once; the session cookie covers checkout approvals and the Activity page.
await page.goto(`${SANDBOX}/signin`);
await page.fill('#email', email);
await page.click('#btnNext').catch(() => {});
await page.fill('#password', password);
await page.click('#btnLogin');
await page.waitForURL(/myaccount|summary/, { timeout: 60_000 }).catch(() => fail('Buyer login'));

// Activity rows aren't links: clicking one expands it in place with "Transaction ID <id>". The top row is the newest.
const newestTxn = async () => {
  await page.goto(`${SANDBOX}/myaccount/activities/`);
  await page.waitForLoadState('networkidle').catch(() => {});
  const row = page.locator('[data-testid="trans_overview_root_container"]').first();
  if (!(await row.count())) return undefined;
  await row.click();
  await page.getByText('Transaction ID').first().waitFor({ timeout: 15_000 }).catch(() => {});
  return (await page.innerText('body')).match(/Transaction ID\s+([A-Z0-9]{17})/)?.[1];
};
// The buyer saves PayPal for the store once (a vault setup token they approve); the agent's orders then charge it.
let vaultId = process.env.AGENT_VAULT_ID;
if (kind === 'agent' && !vaultId) {
  const st = await paypal(ctx, 'POST', '/v3/vault/setup-tokens', { json: { payment_source: { paypal: {
    usage_type: 'MERCHANT', usage_pattern: 'IMMEDIATE', description: 'JUNCO demo store: let your shopping agent pay with PayPal',
    experience_context: { return_url: 'https://example.com/return', cancel_url: 'https://example.com/cancel', vault_instruction: 'ON_PAYER_APPROVAL' } } } } });
  if (st.status >= 300) { console.error('Vault setup failed', st.status, JSON.stringify(st.body)); process.exit(1); }
  await page.goto(st.body.links.find((l: any) => l.rel === 'approve').href);
  await page.getByRole('button', { name: /agree|continue|save|consent/i }).first().click({ timeout: 60_000 }).catch(() => fail('Buyer vault approval'));
  await page.waitForURL(/example\.com/, { timeout: 60_000 }).catch(() => fail('Buyer vault approval redirect'));
  const pt = await paypal(ctx, 'POST', '/v3/vault/payment-tokens', { json: { payment_source: { token: { id: st.body.id, type: 'SETUP_TOKEN' } } } });
  if (pt.status >= 300) { console.error('Vault token failed', pt.status, JSON.stringify(pt.body)); process.exit(1); }
  vaultId = pt.body.id;
  console.log(`Saved the buyer's PayPal for the store. Add AGENT_VAULT_ID=${vaultId} to .env to reuse it.`);
}
let last = await newestTxn();
console.log(`buyer's newest earlier transaction: ${last ?? 'none'}`);
const entries = [];
for (let i = 0, tries = 0; i < Number(n) && tries < Number(n) * 3; tries++) {
  if (kind === 'agent') {
    // The agent shops; the store charges the saved PayPal account only for an item within the budget the agent sent.
    const ask = INSTRUCTIONS[tries % INSTRUCTIONS.length], choice = await shop(ask.instruction, ask.budget);
    if ('declined' in choice) { console.log(`agent bought nothing for "${ask.instruction}": ${choice.declined}`); continue; }
    const item = CATALOG.find((c) => c.sku === choice.sku)!;
    if (Number(item.price) > Number(ask.budget)) { console.log(`store refused ${item.sku} at $${item.price}: over the agent's $${ask.budget} budget`); continue; }
    const o = await paypal(ctx, 'POST', '/v2/checkout/orders', { headers: { 'PayPal-Request-Id': crypto.randomUUID() }, json: {
      intent: 'CAPTURE',
      purchase_units: [{ description: 'Placed by a shopping agent for the buyer', amount: { currency_code: 'USD', value: item.price, breakdown: { item_total: { currency_code: 'USD', value: item.price } } },
        items: [{ name: item.name, sku: item.sku, quantity: '1', unit_amount: { currency_code: 'USD', value: item.price } }] }],
      payment_source: { paypal: { vault_id: vaultId, stored_credential: { payment_initiator: 'MERCHANT', usage: 'SUBSEQUENT', usage_pattern: 'IMMEDIATE' } } },
    } });
    const capture = o.body.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    if (!capture) { console.error('Agent order failed', o.status, JSON.stringify(o.body)); break; }
    const number = `9400${String(Date.now()).padStart(18, '0')}`;
    let txn: string | undefined;
    for (let t = 0; !txn && t < 6; t++) { const top = await newestTxn(); if (top && top !== last) txn = top; else await page.waitForTimeout(10_000); }
    if (!txn) await fail('Reading the buyer transaction ID');
    last = txn;
    entries.push({ buyer_txn: txn, amount: item.price, order_id: o.body.id, tracking: false,
      scan: `USPS ${number}: Delivered, front door, SAN JOSE, CA 95131 (John Doe, 2211 N First St), ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      agent: { instruction: ask.instruction, budget: ask.budget, sku: item.sku, listing: listing(item.sku), reason: choice.reason, agent: AGENT_NAME } });
    console.log(`${++i}/${n}: agent bought ${item.sku} for "${ask.instruction}" (${choice.reason}); order ${o.body.id}, capture ${capture}, buyer transaction ${txn}`);
    continue;
  }
  i++;
  const o = await paypal(ctx, 'POST', '/v2/checkout/orders', { json: {
    intent: 'CAPTURE',
    purchase_units: [{ amount: { currency_code: 'USD', value: '48.00', breakdown: { item_total: { currency_code: 'USD', value: '48.00' } } },
      items: [{ name: 'Canvas tote', quantity: '1', unit_amount: { currency_code: 'USD', value: '48.00' } }] }],
    payment_source: { paypal: { experience_context: { return_url: 'https://example.com/return', cancel_url: 'https://example.com/cancel', user_action: 'PAY_NOW' } } },
  } });
  if (o.status >= 300) { console.error('Order failed', o.status, JSON.stringify(o.body)); break; }
  await page.goto(o.body.links.find((l: any) => l.rel === 'payer-action').href);
  await page.getByRole('button', { name: /pay|complete purchase|continue/i }).first().click({ timeout: 60_000 }).catch(() => fail('Buyer approval'));
  await page.waitForURL(/example\.com/, { timeout: 60_000 }).catch(() => fail('Buyer approval redirect'));

  const c = await paypal(ctx, 'POST', `/v2/checkout/orders/${o.body.id}/capture`, { json: {} });
  const capture = c.body.purchase_units?.[0]?.payments?.captures?.[0]?.id;
  if (!capture) { console.error('Capture failed', c.status, JSON.stringify(c.body)); break; }
  const tracked = kind === 'delivered';
  const number = `9400${String(Date.now()).padStart(18, '0')}`;
  if (tracked) await paypal(ctx, 'POST', `/v2/checkout/orders/${o.body.id}/track`, { json: { capture_id: capture, tracking_number: number, carrier: 'USPS', notify_payer: false } });
  // The store's own delivery record, as a merchant would copy it from the carrier. Labelled on the desk as entered by the store.
  const scan = tracked ? `USPS ${number}: Delivered, front door, SAN JOSE, CA 95131 (John Doe, 2211 N First St), ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC` : undefined;

  // The buyer's transaction ID is only on the buyer's side: wait for a new top row in the buyer's activity.
  let txn: string | undefined;
  for (let tries = 0; !txn && tries < 6; tries++) {
    const top = await newestTxn();
    if (top && top !== last) txn = top; else await page.waitForTimeout(10_000);
  }
  if (!txn) await fail('Reading the buyer transaction ID');
  last = txn;
  entries.push({ buyer_txn: txn, amount: '48.00', order_id: o.body.id, tracking: tracked, ...(scan && { scan }) });
  console.log(`${i}/${n}: order ${o.body.id}, capture ${capture}, buyer transaction ${txn}${tracked ? ', tracked with a delivery record' : ', no tracking'}`);
}
await browser.close();

if (!process.env.OWNER_TOKEN) { console.log('No OWNER_TOKEN; add these by hand:', JSON.stringify(entries)); process.exit(0); }
const r = await fetch(`${DESK}/api/pool`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Owner-Token': process.env.OWNER_TOKEN,
  Authorization: `Basic ${Buffer.from(`owner:${process.env.DESK_PASSWORD}`).toString('base64')}` }, body: JSON.stringify({ entries }) });
console.log('desk pool:', r.status, await r.text());
