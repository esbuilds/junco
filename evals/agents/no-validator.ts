// DisputeBench baseline 2 (STRATEGY v3.14 item 6): the same model and settings as JUNCO, without what JUNCO adds around
// it. The evidence goes in as plain unnumbered lines, the prompt is a plain task description without JUNCO's rules
// (citations, quotes, what a message may claim), and nothing checks the answer: it returns problems: [] so the runner
// takes it as sent. The runner still measures what would have reached PayPal or the buyer unchecked.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';

const Answer = z.object({
  decision: z.enum(['accept', 'offer', 'contest', 'message', 'wait']),
  summary: z.string(),
  offer_amount: z.string().nullable().describe('For offer: refund amount like "12.00", else null'),
  message_to_buyer: z.string().nullable().describe('Message to send the buyer, if any'),
});
const SYSTEM = 'You help a small online merchant respond to PayPal disputes. Read the dispute and the information below and recommend one of: accept (refund in full), offer (partial refund), contest (submit evidence), message (write to the buyer), or wait. Write the message to the buyer if one should be sent.';
const client = new Anthropic();
// The same baseline on a smaller model: BASELINE_MODEL=claude-sonnet-5-5 (or claude-haiku-5-5) npm run eval -- --agent ...
const MODEL = process.env.BASELINE_MODEL ?? 'claude-opus-5-5';

export async function decide(_dispute: any, evidence: { source: string; text: string }[]) {
  const res = await client.beta.messages.parse({
    model: MODEL, max_tokens: 16000,
    output_config: { effort: 'high', format: betaZodOutputFormat(Answer) }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    system: SYSTEM,
    messages: [{ role: 'user', content: evidence.map((e) => `${e.source}: ${e.text}`).join('\n') }],
  });
  const a = res.parsed_output;
  return { recommendation: a && { ...a, claims: [] }, problems: [], usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } };
}
