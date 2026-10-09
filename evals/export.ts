// DisputeBench export: every scenario as plain JSON (the dispute and evidence an agent sees, plus the answers a careful
// advisor could defend and the ones that are clearly wrong), for agents that aren't written in TypeScript.
//   npm run bench:export   writes evals/disputebench.json
import { writeFileSync } from 'node:fs';
import { scenarios, build } from './scenarios.js';

const cases = scenarios.map((s) => ({ id: s.id, tag: s.tag, why: s.why, ...build(s), acceptable: s.ok, wrong: s.never ?? [] }));
writeFileSync('evals/disputebench.json', JSON.stringify({ name: 'DisputeBench', version: 1, decisions: ['accept', 'offer', 'contest', 'message', 'wait'], cases }, null, 2) + '\n');
console.log(`wrote evals/disputebench.json (${cases.length} cases)`);
