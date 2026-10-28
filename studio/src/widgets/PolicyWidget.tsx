import { useEffect, useState } from 'react';
import { api } from '../api';
import { usePoll } from '../store';
import { Panel } from './Panel';
import { DESK_LAYOUT_KEY } from '../ui';

// Owner policy: what JUNCO may do on its own and what waits for approval. The gate reads it on every call.
type PolicyView = { offer_limit: number; ship_within_days: number; negotiation: { open_pct: number; ceiling_pct: number; max_rounds: number }; auto: Record<string, boolean> };
const ACTIONS: [string, string, string][] = [
  ['send_dispute_message', 'Message the buyer', 'No money moves'],
  ['provide_dispute_evidence', 'Submit evidence to PayPal', 'Contests the case'],
  ['provide_dispute_supporting_info', 'Add supporting info while PayPal reviews', 'Contests the case'],
  ['accept_dispute_claim', 'Accept a claim', 'Refunds the buyer in full'],
  ['create_refund', 'Issue a refund', 'Moves money'],
];

// T1: every tool the gate exposes, grouped by class. Anything without a class is denied.
type ToolRow = { tool: string; class: string; on: string[] };
const CLASS_ORDER = ['read', 'allowed write', 'hold', 'not exposed'];
function ToolMatrix() {
  const { data } = usePoll<{ hosted_connected: boolean; tools: ToolRow[] }>('/api/policy/tools', 300000);
  if (!data) return null;
  const groups = new Map<string, ToolRow[]>();
  for (const t of data.tools) {
    const key = t.class.startsWith('allowed write up to') ? 'allowed write' : t.class;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const keys = [...groups.keys()].sort((a, b) => (CLASS_ORDER.indexOf(a) + 1 || 9) - (CLASS_ORDER.indexOf(b) + 1 || 9));
  return (
    <details className="jd-whatif">
      <summary><strong>Every tool the gate knows ({data.tools.length})</strong> <span className="jd-muted">JUNCO's and PayPal's hosted MCP server's. A tool with no class is denied.{data.hosted_connected ? '' : " PayPal's hosted server isn't connected right now."}</span></summary>
      {keys.map((k) => (
        <div key={k} className="jd-matrix-row">
          <strong>{k}</strong>
          <span className="jd-whatif-cases">{groups.get(k)!.map((t) => <span key={t.tool} className="jd-badge jd-b-wait" title={`${t.class}; on ${t.on.join(' and ')}`}>{t.tool}</span>)}</span>
        </div>
      ))}
    </details>
  );
}

export function PolicyWidget() {
  const { data, error, reload } = usePoll<PolicyView>('/api/policy', 30000);
  const [draft, setDraft] = useState<PolicyView | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (data && !draft) setDraft(data); }, [data, draft]);
  // What-if: replay saved recommendations under the draft (server uses the gate's own rules; no PayPal calls).
  const [what, setWhat] = useState<{ handled: number; total: number; cases: { id: string; decision: string; handled: boolean }[] } | null>(null);
  useEffect(() => {
    if (!draft) return;
    const t = setTimeout(() => { api('/api/policy/what-if', { method: 'POST', json: draft }).then(setWhat).catch(() => setWhat(null)); }, 300);
    return () => clearTimeout(t);
  }, [draft]);

  const send = async (method: 'PUT' | 'DELETE') => {
    setMsg(null);
    try {
      const next = await api<PolicyView>('/api/policy', method === 'PUT' ? { method, json: draft } : { method });
      setDraft(next); reload();
      setMsg({ ok: true, text: method === 'PUT' ? 'Saved. The gate uses this from the next action.' : 'Reset to the default policy.' });
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
  };

  if (!draft) return <Panel title="Policy">{error ? <div className="jd-result jd-err">{error}</div> : <div className="jd-empty">Loading</div>}</Panel>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data);

  return (
    <Panel title="Policy" subtitle="What JUNCO does on its own, and what waits for you">
      <label className="jd-policy-row">
        <span><strong>Auto-offer limit</strong><span className="jd-muted">Partial refund offers up to this amount go out without asking. Larger offers wait for you.</span></span>
        <span className="jd-money-input">$<input type="number" min={0} max={500} step={1} value={draft.offer_limit}
          onChange={(e) => setDraft({ ...draft, offer_limit: Number(e.target.value) })} aria-label="Auto-offer limit in dollars" /></span>
      </label>
      <label className="jd-policy-row">
        <span><strong>Ship-by window</strong><span className="jd-muted">Shipment watch flags a paid order with no tracking on PayPal after this many days.</span></span>
        <span className="jd-money-input"><input type="number" min={1} max={30} step={1} value={draft.ship_within_days}
          onChange={(e) => setDraft({ ...draft, ship_within_days: Number(e.target.value) })} aria-label="Ship-by window in days" /> days</span>
      </label>
      {/* v3.14: the Negotiation fields are not shown; negotiation can't run live (buyer replies 403 in the sandbox). The values still save. */}
      {ACTIONS.map(([key, label, note]) => (
        <label key={key} className="jd-policy-row">
          <span><strong>{label}</strong><span className="jd-muted">{note}</span></span>
          <select value={draft.auto[key] ? 'allow' : 'hold'} onChange={(e) => setDraft({ ...draft, auto: { ...draft.auto, [key]: e.target.value === 'allow' } })} aria-label={label}>
            <option value="allow">Do it</option>
            <option value="hold">Ask me first</option>
          </select>
        </label>
      ))}
      {what && what.total > 0 && (
        <div className="jd-whatif" aria-live="polite">
          <strong>JUNCO would have handled {what.handled} of {what.total} recommended action{what.total === 1 ? '' : 's'} without you</strong>
          <span className="jd-muted">{dirty ? 'with these unsaved settings' : 'with the current policy'}, replaying its saved recommendations. The rest would wait for your OK.</span>
          <span className="jd-whatif-cases">{what.cases.map((c) => <span key={c.id} className={`jd-badge ${c.handled ? 'jd-b-contest' : 'jd-b-held'}`} title={c.id}>{c.decision} {c.handled ? 'runs' : 'waits'}</span>)}</span>
        </div>
      )}
      <div className="jd-row">
        <button type="button" className="jd-btn jd-primary" disabled={!dirty} onClick={() => send('PUT')}>Save policy</button>
        <button type="button" className="jd-btn" onClick={() => send('DELETE')}>Reset to default</button>
      </div>
      {msg && <div className={`jd-result ${msg.ok ? 'jd-ok' : 'jd-err'}`}>{msg.text}</div>}
      <p className="jd-muted">The desk is yours to arrange: on the Desk, drag any edge of a panel to resize it, and this browser remembers it. <button type="button" className="jd-linkish" onClick={() => { try { localStorage.removeItem(DESK_LAYOUT_KEY); } catch { /* nothing saved */ } location.reload(); }}>Reset the layout</button></p>
      <ToolMatrix />
    </Panel>
  );
}
