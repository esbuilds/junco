// Owner CLI for held actions: npm run holds | npm run holds approve <id> | npm run holds reject <id>
import { readHolds } from './gate.js';
import { createServer, sandboxCtx } from './server.js';

const [cmd, id] = process.argv.slice(2);
if (!cmd) {
  const pending = readHolds().filter((h) => h.status === 'pending');
  if (!pending.length) console.log('No pending holds.');
  for (const h of pending) console.log(`${h.id}  ${h.method}  ${JSON.stringify(h.args)}\n          why held: ${h.reason}`);
} else if ((cmd === 'approve' || cmd === 'reject') && id) {
  const { holds } = await createServer(await sandboxCtx());
  const h = await holds[cmd](id);
  console.log(`${h.id} ${h.status}${h.result ? `: ${h.result}` : ''}`);
} else {
  console.log('usage: npm run holds [approve|reject <id>]');
}
