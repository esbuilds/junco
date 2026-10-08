// Runs every scenario through the production prompt + validator and scores it in code (no model judges).
//   npm run eval                 all scenarios
//   npm run eval -- inr-         only ids starting with "inr-"
import { writeFileSync, mkdirSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { decide } from '../src/recommend.js';
import { scenarios, build } from './scenarios.js';

try { process.loadEnvFile(); } catch {}
const prefix = process.argv[2] ?? '';
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
      const out = await decide(dispute, evidence, client);
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
writeFileSync(`evals/results/${stamp}.json`, JSON.stringify({ summary, rows }, null, 2));
console.log(`saved evals/results/${stamp}.json`);
