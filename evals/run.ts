// Runs every scenario through the production prompt + validator and scores it in code (no model judges).
//   npm run eval                 all scenarios
//   npm run eval -- inr-         only ids starting with "inr-"
//   npm run eval -- --agent ./my-agent.ts   DisputeBench: score any agent that exports decide(dispute, evidence)
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { decide, validate } from '../src/recommend.js';
import { scenarios, build } from './scenarios.js';

try { process.loadEnvFile(); } catch {}
const args = process.argv.slice(2);
const agentPath = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : null;
const prefix = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--agent') ?? '';
// An outside agent returns { decision } or a full recommendation ({ decision, summary, claims: [{ text, evidence_ids }] }).
// Full recommendations go through JUNCO's validator, so invented citations count against any agent.
const external = agentPath ? (await import(pathToFileURL(resolve(agentPath)).href)).decide as (dispute: any, evidence: any[]) => Promise<any> : null;
const picked = scenarios.filter((s) => s.id.startsWith(prefix));
const client = new Anthropic();
const CONCURRENCY = 4;

type Row = { id: string; tag: string; decision: string; verdict: 'pass' | 'acceptable-but-blocked' | 'wrong' | 'outside-expected' | 'error'; problems: string[]; summary: string; tokens: { input: number; output: number } };
const rows: Row[] = [];
let next = 0;
async function worker() {
  while (next < picked.length) {
    const s = picked[next++];
    const { dispute, evidence } = build(s);
    try {
      const out = external ? await (async () => {
        const raw = await external(dispute, evidence);
        const rec = raw?.recommendation ?? (raw?.decision ? raw : null);
        return { recommendation: rec, problems: raw?.problems ?? (rec?.claims ? validate(rec, evidence, dispute) : []), usage: raw?.usage ?? { input: 0, output: 0 } };
      })() : await decide(dispute, evidence, client);
      const d = out.recommendation?.decision ?? 'none';
      const verdict = !out.recommendation ? 'error'
        : s.never?.includes(d as any) ? 'wrong'
        : !s.ok.includes(d as any) ? 'outside-expected'
        : out.problems.length ? 'acceptable-but-blocked' : 'pass';
      rows.push({ id: s.id, tag: s.tag, decision: d, verdict, problems: out.problems, summary: out.recommendation?.summary ?? '', tokens: out.usage });
      console.log(`${verdict.padEnd(22)} ${s.id.padEnd(30)} ${d}${out.problems.length ? `  [${out.problems.join('; ')}]` : ''}`);
    } catch (e: any) {
      rows.push({ id: s.id, tag: s.tag, decision: 'none', verdict: 'error', problems: [e.message], summary: '', tokens: { input: 0, output: 0 } });
      console.log(`error                  ${s.id}  ${e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const n = rows.length, count = (f: (r: Row) => boolean) => rows.filter(f).length;
const invented = count((r) => r.problems.some((p) => /missing evidence|Uncited/.test(p)));
const injections = rows.filter((r) => r.tag === 'injection');
const tokens = rows.reduce((t, r) => ({ input: t.input + r.tokens.input, output: t.output + r.tokens.output }), { input: 0, output: 0 });
const cost = (tokens.input * 4 + tokens.output * 20) / 1e6; // Claude Opus 5.5 list price per million tokens
const byTag = [...new Set(rows.map((r) => r.tag))].map((t) => `${t}: ${count((r) => r.tag === t && r.verdict === 'pass')}/${count((r) => r.tag === t)}`).join(', ');
const summary = {
  scenarios: n, pass: count((r) => r.verdict === 'pass'), wrong: count((r) => r.verdict === 'wrong'),
  outside_expected: count((r) => r.verdict === 'outside-expected'), blocked_by_validator: count((r) => r.verdict === 'acceptable-but-blocked'),
  errors: count((r) => r.verdict === 'error'), invented_citations: invented,
  injections_resisted: `${count((r) => r.tag === 'injection' && r.verdict !== 'wrong' && r.verdict !== 'error')}/${injections.length}`,
  by_tag: byTag, tokens, cost_usd: Number(cost.toFixed(2)),
};
console.log('\n' + JSON.stringify(summary, null, 2));
mkdirSync('evals/results', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const agentName = agentPath ? agentPath.split('/').pop()!.replace(/\.[^.]+$/, '') : 'junco';
const file = `evals/results/${stamp}${agentPath ? `-${agentName}` : ''}.json`;
writeFileSync(file, JSON.stringify({ agent: agentName, summary, rows }, null, 2));
console.log(`saved ${file}`);
