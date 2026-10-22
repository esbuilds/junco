// S3 spike: the hold as a card inside the agent's chat (MCP Apps, io.modelcontextprotocol/ui, spec 2026-01-26). Every
// tool the policy can hold carries _meta.ui.resourceUri, so a host that renders apps (Claude web and Desktop) shows this
// card with the call's result: what was held and why, then how it ended, polled through an app-only status tool.
// No approve button: whoever is chatting may be the attacker; approval stays with the owner's desk and one-tap link.
import { z } from 'zod';
import type { Hold, Policy } from './gate.js';

export const HOLD_CARD = 'ui://junco/hold-card';
const MIME = 'text/html;profile=mcp-app';

// What a hold has become, in a sentence for the card.
export function holdNews(h: Hold | undefined) {
  if (!h) return { done: true, text: 'This hold is no longer on the desk.' };
  const why = (() => { try { return JSON.parse(h.result ?? '{}')?.error?.message as string | undefined; } catch { return undefined; } })();
  const text: Record<string, string> = {
    pending: h.recheck ? `Waiting for the owner. PayPal says this changed since it was held (${h.recheck.event}); approving re-reads it first.` : 'Waiting for the owner. Nothing has gone to PayPal.',
    executing: 'Approved by the owner. Sending it to PayPal now.',
    completed: 'Approved by the owner, and PayPal accepted it.',
    failed: `Approved by the owner, but PayPal refused it${why ? `: ${why}` : ''}.`,
    unknown: 'Approved by the owner; the outcome is being checked with PayPal.',
    rejected: 'Rejected by the owner. Nothing was sent to PayPal.',
    stale: `${why ?? 'Not run: the case changed since it was held'}. Nothing was sent to PayPal.`,
  };
  return { done: !['pending', 'executing', 'unknown'].includes(h.status), text: text[h.status] ?? h.status };
}

export function addHoldCard(server: any, policy: Policy, readHolds: () => Hold[]) {
  server.registerResource('hold_card', HOLD_CARD, { mimeType: MIME, description: "JUNCO's hold card: a held PayPal call and how it ended" },
    async () => ({ contents: [{ uri: HOLD_CARD, mimeType: MIME, text: PAGE }] }));
  server.registerTool('junco_hold_status', {
    description: "How a held call ended (the hold card polls this). Read only.",
    inputSchema: { hold_id: z.string().regex(/^[\w-]{1,16}$/) },
    _meta: { ui: { resourceUri: HOLD_CARD, visibility: ['app'] } },
  }, async ({ hold_id }: { hold_id: string }) => {
    const h = readHolds().find((x) => x.id === hold_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ hold_id, status: h?.status ?? 'missing', ...holdNews(h) }) }] };
  });
  for (const [name, t] of Object.entries(server._registeredTools) as [string, any][]) {
    const rule = policy.tools[name];
    if (rule === 'hold' || typeof rule === 'object') t.update({ _meta: { ...t._meta, ui: { resourceUri: HOLD_CARD }, 'ui/resourceUri': HOLD_CARD } });
  }
}

// The card. Plain JS over postMessage (JSON-RPC 2.0), no external resources, text only through textContent.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
:root{color-scheme:light dark;--bg:#fbf3e4;--ink:#1d2421;--m:#5d6662;--acc:#1f5c4a;--warn:#8a4b05;--danger:#a8322a;--line:#e3d6bd}
@media (prefers-color-scheme:dark){:root{--bg:#231d12;--ink:#e8ece9;--m:#9aa49f;--acc:#5fb497;--warn:#e5a54a;--danger:#ef8a80;--line:#4a3d26}}
body{margin:0;font:14px/1.45 Inter,system-ui,sans-serif;color:var(--ink);background:transparent}
.c{border:1px solid var(--line);border-left:4px solid var(--warn);border-radius:10px;padding:12px 14px;background:var(--bg)}
.c.ok{border-left-color:var(--acc)}.c.no{border-left-color:var(--danger)}
.k{font-size:12px;color:var(--m);text-transform:uppercase;letter-spacing:.04em}h1{font-size:16px;margin:4px 0}.m{color:var(--m)}.s{font-weight:600;margin-top:8px}
</style></head><body><div class="c" id="c"><div class="k">JUNCO gate</div><div class="m" id="s">Waiting for the result...</div></div><script>
var n = 0, pending = {}, card = document.getElementById('c');
function send(method, params) { return new Promise(function (res) { var id = ++n; pending[id] = res; parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params }, '*'); }); }
function notify(method, params) { parent.postMessage({ jsonrpc: '2.0', method: method, params: params }, '*'); }
function line(cls, text) { var d = document.createElement(cls === 'h1' ? 'h1' : 'div'); if (cls !== 'h1') d.className = cls; d.textContent = text; return d; }
function size() { notify('ui/notifications/size-changed', { height: Math.ceil(document.documentElement.getBoundingClientRect().height) }); }
new ResizeObserver(size).observe(document.body);
window.addEventListener('message', function (e) {
  var m = e.data; if (!m || m.jsonrpc !== '2.0') return;
  if (m.id != null && !m.method) { if (pending[m.id]) { pending[m.id](m.result || {}); delete pending[m.id]; } return; }
  if (m.method === 'ui/notifications/tool-result') show(m.params || {});
  else if (m.id != null) parent.postMessage({ jsonrpc: '2.0', id: m.id, result: {} }, '*'); // e.g. ui/resource-teardown
});
function textOf(r) { return ((r.content || [])[0] || {}).text || ''; }
function show(r) {
  var out; try { out = JSON.parse(textOf(r)); } catch (e) { out = { text: textOf(r) }; }
  card.replaceChildren(line('k', 'JUNCO gate'));
  if (!out.held) {
    card.className = 'c ' + (out.error || r.isError ? 'no' : 'ok');
    card.append(line('h1', out.error ? 'Not sent' : 'Allowed by the owner\\'s policy'), line('m', out.error ? (out.error.message || 'Refused') : 'This call was within the owner\\'s limits and went to PayPal.'));
    return size();
  }
  card.className = 'c';
  card.append(line('h1', 'Held for the owner'), line('m', out.reason || ''), line('s', 'Waiting for the owner. Nothing has gone to PayPal.'), line('m', 'Hold ' + out.hold_id + '. The owner approves or rejects it from the desk or a one-tap link; this card updates when they do.'));
  size(); poll(out.hold_id, 0);
}
function poll(id, i) {
  if (i > 360) return;
  setTimeout(function () {
    send('tools/call', { name: 'junco_hold_status', arguments: { hold_id: id } }).then(function (r) {
      var s; try { s = JSON.parse(textOf(r)); } catch (e) { return poll(id, i + 1); }
      card.querySelector('.s').textContent = s.text;
      if (s.done) { card.className = 'c ' + (s.status === 'completed' ? 'ok' : 'no'); size(); } else poll(id, i + 1);
    });
  }, 5000);
}
send('ui/initialize', { appCapabilities: { availableDisplayModes: ['inline'] }, clientInfo: { name: 'junco-hold-card', version: '1.0.0' }, protocolVersion: '2026-01-26' })
  .then(function () { notify('ui/notifications/initialized', {}); size(); });
</script></body></html>`;
