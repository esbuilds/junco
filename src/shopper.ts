// v3.15 move 1: the buyer's shopping agent. A Claude agent gets a buyer's instruction and budget, reads the demo store's
// catalog, and either buys one item (the store then charges the PayPal account the buyer saved for it) or buys nothing.
// It runs for the pool filler only (src/pool.ts agent); the desk never shops. Its choice is whatever the model decides:
// the cases JUNCO later gets are not scripted to make the agent wrong.
import { claude } from './spend.js';

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
    model: 'claude-sonnet-5-5', max_tokens: 600,
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
