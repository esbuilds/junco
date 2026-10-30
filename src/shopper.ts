// v3.15 move 1: the buyer's shopping agent. A Claude agent gets a buyer's instruction and budget, reads the demo store's
// catalog, and either buys one item (the store then charges the PayPal account the buyer saved for it) or buys nothing.
// It runs for the pool filler (src/pool.ts agent) and for desk visitors ("Your AI buys, you investigate", /api/shop).
// Its choice is whatever the model decides: the cases JUNCO later gets are not scripted to make the agent wrong.
import { paypal, type Ctx } from './disputes.js';
import { claude, claudeDown, isClaudeDown, pausedText } from './spend.js';
import { addAgentBuy, addDeclines, addShopTry, declineId, readDeclines, readShopTries } from './store-dispute.js';
import { fingerprint, type FingerprintRecord } from './fingerprint.js';

export const MODEL = 'claude-sonnet-5-5';

export const CATALOG = [
  { sku: 'WKD-01', name: 'Waxed canvas weekender', price: '62.00',
    text: 'Water-resistant waxed cotton canvas, 45 L, 50 x 28 x 25 cm, leather handles. Sheds rain; not waterproof and not for submersion. Rewax once a year.' },
  { sku: 'WKD-02', name: 'Rolltop dry duffel', price: '74.00',
    text: 'Waterproof TPU-coated nylon with welded seams and a roll-top closure, 40 L, 55 x 35 x 22 cm. Backpack straps.' },
  { sku: 'WKD-03', name: 'Packable nylon weekender', price: '38.00',
    text: 'Ripstop nylon, 35 L, 48 x 26 x 24 cm, folds into its own pocket. For light rain only.' },
];

// Instructions a buyer might give an agent; the filler cycles through them.
export const INSTRUCTIONS = [
  { instruction: 'Get me a waterproof weekend bag I can take kayaking, under $70.', budget: '70.00' },
  { instruction: 'I need a carry-on weekend bag that looks nice. Keep it under $70.', budget: '70.00' },
  { instruction: 'Cheapest bag that fits a weekend of clothes. Light rain is fine.', budget: '50.00' },
];

export const AGENT_NAME = 'a test shopping agent run by this demo (Claude Sonnet 5.5)';
export type Choice = { sku: string; reason: string } | { declined: string };

export async function shop(instruction: string, budget: string): Promise<Choice> {
  const r = await claude().messages.create({
    model: MODEL, max_tokens: 600,
    system: 'You are a shopping agent buying for a person. Buy at most one item from the store catalog that fits their instruction and budget, or decline if nothing fits. Call exactly one tool.',
    tools: [
      { name: 'buy', description: 'Buy one item. reason: one or two sentences to the store on why this item fits the instruction.',
        input_schema: { type: 'object', properties: { sku: { type: 'string', enum: CATALOG.map((c) => c.sku) }, reason: { type: 'string' } }, required: ['sku', 'reason'] } },
      { name: 'decline', description: 'Buy nothing and say why.', input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } },
    ],
    messages: [{ role: 'user', content: `Instruction: ${instruction}\nBudget: $${budget}\n\nCatalog:\n${CATALOG.map((c) => `${c.sku} ${c.name}, $${c.price}. ${c.text}`).join('\n')}` }],
  });
  const t: any = r.content.find((b) => b.type === 'tool_use');
  if (t?.name === 'buy' && CATALOG.some((c) => c.sku === t.input.sku)) return { sku: t.input.sku, reason: String(t.input.reason) };
  return { declined: String(t?.input?.reason ?? 'no tool call') };
}

export const listing = (sku: string) => { const c = CATALOG.find((x) => x.sku === sku)!; return `${c.sku} ${c.name}, $${c.price}. ${c.text}`; };

// The store's side of an agent checkout, for pool.ts and /api/shop: the price is the catalog's, never the agent's; an item
// over the agent's budget is refused before PayPal is called. One merchant-initiated order on the saved PayPal account,
// captured in the same call.
type Item = (typeof CATALOG)[number];
// The mandate (instruction, budget, model, time) is set before PayPal is called; its fingerprint goes into PayPal's order
// as custom_id and invoice_id. After the capture, PayPal's copy is read back and kept on the record (fingerprint.ts).
export type Charge = { refused: string } | { failed: { status: number; body: any } } | { item: Item; order_id: string; capture_id: string; paid_at: string; mandate: FingerprintRecord };
export async function charge(ctx: Ctx, sku: string, budget: string, vaultId: string | undefined, instruction: string): Promise<Charge> {
  const item = CATALOG.find((c) => c.sku === sku);
  if (!item) return { refused: `store refused ${sku}: not in the catalog` };
  if (Number(item.price) > Number(budget)) return { refused: `store refused ${item.sku} at $${item.price}: over the agent's $${budget} budget` };
  const at = new Date().toISOString(), fp = fingerprint({ instruction, budget, model: MODEL, at });
  const o = await paypal(ctx, 'POST', '/v2/checkout/orders', { headers: { 'PayPal-Request-Id': crypto.randomUUID() }, json: {
    intent: 'CAPTURE',
    purchase_units: [{ custom_id: `junco:m:${fp}`, invoice_id: `JUNCO-M-${fp}-${at.replace(/\D/g, '').slice(0, 12)}`, description: 'Placed by a shopping agent for the buyer', amount: { currency_code: 'USD', value: item.price, breakdown: { item_total: { currency_code: 'USD', value: item.price } } },
      items: [{ name: item.name, sku: item.sku, quantity: '1', unit_amount: { currency_code: 'USD', value: item.price } }] }],
    payment_source: { paypal: { vault_id: vaultId, stored_credential: { payment_initiator: 'MERCHANT', usage: 'SUBSEQUENT', usage_pattern: 'IMMEDIATE' } } },
  } });
  const cap = o.body?.purchase_units?.[0]?.payments?.captures?.[0];
  if (!cap?.id) return { failed: o };
  const back = await paypal(ctx, 'GET', `/v2/checkout/orders/${o.body.id}`); // a read, no money moves
  const copy = back.body?.purchase_units?.[0] ?? {};
  return { item, order_id: o.body.id, capture_id: cap.id, paid_at: cap.create_time ?? new Date().toISOString(),
    mandate: { model: MODEL, at, fingerprint: fp, paypal: { custom_id: copy.custom_id, invoice_id: copy.invoice_id, read_at: new Date().toISOString() } } };
}

// "Your AI buys, you investigate": a desk visitor's ask and budget, the agent's choice, then a decline or a guarded order.
// The checks run cheapest first, and nothing reaches Claude until all of them pass. The caps count every attempt that
// reached Claude. The owner skips the per-session cap, not the daily one.
export const SHOP_MAX_BUDGET = 80;
const PER_SESSION = () => Number(process.env.SHOP_PER_SESSION ?? 2), PER_DAY = () => Number(process.env.SHOP_PER_DAY ?? 20);
export function shopLeft(session: string) {
  const today = new Date().toISOString().slice(0, 10), tries = readShopTries().filter((t) => t.at.startsWith(today));
  return { you: Math.max(0, PER_SESSION() - tries.filter((t) => t.session === session).length), today: Math.max(0, PER_DAY() - tries.length) };
}
const no = (code: number, message: string) => Object.assign(new Error(message), { code });
export async function visitorShop(ctx: Ctx, v: { session: string; owner: boolean; instruction: unknown; budget: unknown }) {
  const vault = process.env.AGENT_VAULT_ID;
  if (!vault) throw no(400, 'Shopping is off on this desk.');
  const instruction = typeof v.instruction === 'string' ? v.instruction.trim().replace(/\s+/g, ' ') : '';
  if (instruction.length < 3 || instruction.length > 200) throw no(400, 'Say what to buy in 3 to 200 characters.');
  const n = Number(v.budget);
  if (!Number.isFinite(n) || n < 1 || n > SHOP_MAX_BUDGET) throw no(400, `The budget is a number of dollars from 1 to ${SHOP_MAX_BUDGET}.`);
  const budget = n.toFixed(2), left = shopLeft(v.session);
  if (!left.today) throw no(429, 'The shopping agent has had its runs for today. Come back tomorrow.');
  if (!left.you && !v.owner) throw no(429, `That was your last shopping run today (${PER_SESSION()} a visitor). Your incidents are below.`);
  if (claudeDown()) throw no(503, pausedText());
  addShopTry(v.session);
  let choice: Choice;
  try { choice = await shop(instruction, budget); }
  catch (e: any) { throw no(isClaudeDown(e) ? 503 : 502, isClaudeDown(e) ? pausedText() : 'The shopping agent did not answer. Nothing was bought.'); }
  if ('declined' in choice) {
    let t = Date.now(); // the id is the time: two declines in one millisecond must not share it
    while (readDeclines().some((d) => d.id === declineId(new Date(t).toISOString()))) t++;
    const at = new Date(t).toISOString();
    addDeclines([{ at, instruction, budget, reason: choice.declined, agent: AGENT_NAME, listings: CATALOG.map((c) => listing(c.sku)) }], v.session);
    return { id: declineId(at), bought: false, text: `Your agent bought nothing: ${choice.declined}` };
  }
  let c: Charge;
  try { c = await charge(ctx, choice.sku, budget, vault, instruction); }
  catch { throw no(502, 'The store could not reach PayPal to charge the saved PayPal account. Nothing was bought.'); }
  if ('refused' in c) throw no(400, `The store refused it: your agent picked ${choice.sku}, which costs more than your $${budget} budget. Nothing was bought.`);
  if ('failed' in c) {
    const declined = (c.failed.body?.details ?? []).some((d: any) => /DECLINED/.test(String(d?.issue)));
    throw no(502, `The store could not charge the saved PayPal account${declined ? ': PayPal declined the payment' : ` (PayPal answered ${c.failed.status})`}. Nothing was bought.`);
  }
  addAgentBuy({ capture_id: c.capture_id, order_id: c.order_id, amount: c.item.price, session: v.session, added: new Date().toISOString(),
    agent: { instruction, budget, sku: c.item.sku, listing: listing(c.item.sku), reason: choice.reason, agent: AGENT_NAME, capture_id: c.capture_id, paid_at: c.paid_at, mandate: c.mandate } });
  return { id: c.capture_id, bought: true, text: `Your agent bought ${c.item.name} for $${c.item.price}: ${choice.reason}` };
}
