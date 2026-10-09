// AG Studio's AI assistant, browser half. Studio runs its own agents and dashboard tools here; each model turn goes to
// the desk (/api/studio-ai), which calls Claude and streams Studio's events back. No API key in the browser.
import { AgStudioAiModule, AgStudioModuleRegistry, createAiHarness, type AgAiEvent, type AgLlmAdapter, type AgLlmResponse } from 'ag-studio';

export const QUESTION = 'Which disputes am I about to lose this week?';
// The starter button shows the question and sends it with the ask for a widget, so the answer lands on the Desk.
const PROMPT = `${QUESTION} Count every open dispute JUNCO says to Accept, whatever its deadline (the At risk panel's rule). Add one bar chart to this page showing the amount for each of them by dispute, then tell me in two sentences.`;

// Running token count for this tab, read by the reliability check (npm run check-studio-ai).
const usage = { calls: 0, input: 0, cached: 0, cacheWrite: 0, output: 0 };
(window as any).__studioUsage = usage;
function tally(r: AgLlmResponse) {
  usage.calls++;
  usage.input += r.usage?.inputTokens ?? 0; usage.cached += r.usage?.cachedInputTokens ?? 0;
  usage.cacheWrite += r.usage?.cacheWriteTokens ?? 0; usage.output += r.usage?.outputTokens ?? 0;
}

const adapter: AgLlmAdapter = {
  executeTurn(request, options) {
    const queue: AgAiEvent[] = [];
    let wake = null as (() => void) | null, ended = false;
    let finish!: (r: AgLlmResponse) => void;
    const complete = new Promise<AgLlmResponse>((r) => (finish = r));
    const failed = (message: string): AgLlmResponse => ({ id: 'failed', createdAt: Date.now(), output: [], status: 'failed', error: { code: 'network', message } });
    (async () => {
      try {
        const r = await fetch('/api/studio-ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, trace: options?.trace }), signal: options?.signal });
        if (!r.ok || !r.body) throw new Error(`desk returned ${r.status}`);
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (!line) continue;
            const o = JSON.parse(line);
            if (o.done) { tally(o.done); finish(o.done); } else { queue.push(o); wake?.(); }
          }
        }
        finish(failed('The desk closed the stream early.'));
      } catch (e: any) {
        finish(options?.signal?.aborted ? { ...failed('Cancelled'), status: 'cancelled' } : failed(e.message));
      } finally { ended = true; wake?.(); }
    })();
    return {
      complete,
      stream: {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length) { yield queue.shift()!; continue; }
            if (ended) return;
            await new Promise<void>((r) => (wake = r));
            wake = null;
          }
        },
      },
    };
  },
};

let registered = false;
export function aiSetup() {
  if (!registered) { AgStudioModuleRegistry.registerModules([AgStudioAiModule]); registered = true; }
  return ({ api }: { api: any }) => {
    (window as any).__studio = api; // read by the reliability check (npm run check-studio-ai)
    return createAiHarness(api, { adapter, primary: 'lead', promptStarters: [{ label: QUESTION, prompt: PROMPT }] });
  };
}
