import { useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, type ColDef } from 'ag-grid-community';
import type { IncidentSummary } from '../../../src/incident-types';
import type { Bucket, Quote, QuoteField, WhoElseRun, WhoElseScore } from '../../../src/whoelse-types';
import { gridTheme } from '../theme';
import { api, HOLD_STATUS, money } from '../api';
import { usePoll } from '../store';
import { inGroups, keptTotal, noSharedMistake, quoteParts, toPlan, trialLines, whoElseRows, type WhoElseRow } from '../ui';
import { Panel } from './Panel';

ModuleRegistry.registerModules([AllCommunityModule]);

// Who else?: every purchase the finder read, in an AG Grid grouped by what code decided, with money totals per group.
// All of it goes through the desk's routes; nothing here picks an amount or a capture. Visitors read, the owner acts.
const LIVE = <span className="jd-mode jd-mode-live">LIVE</span>;
const RECORDED = <span className="jd-mode jd-mode-recorded">RECORDED</span>;
const FIELD: Record<QuoteField, string> = { instruction: 'The buyer asked', reason: 'The agent said', listing: 'The listing said' };
const BAD_HOLD = new Set(['failed', 'unknown', 'stale', 'expired']);
const day = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const Marked = ({ text, quotes, field }: { text: string; quotes: Quote[]; field: QuoteField }) => <>{quoteParts(text, quotes, field).map((p, i) => p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>)}</>;
const dollars = (p: { value?: number | null }) => p.value == null ? '' : money(p.value);

function Detail({ r, seed }: { r: WhoElseRow; seed: string }) {
  const m = r.member!, n = r.remedy;
  return (
    <section className="jd-whoelse-detail" aria-label="The purchase you picked">
      <h3>Purchase ...{m.incident_id.slice(-6)}{m.incident_id === seed && ' · where this started'}</h3>
      <p>{m.why}</p>
      <dl className="jd-facts">
        <dt>The buyer asked</dt><dd><Marked text={m.instruction} quotes={m.quotes} field="instruction" /></dd>
        <dt>The agent said</dt><dd><Marked text={m.reason} quotes={m.quotes} field="reason" /></dd>
        {m.quotes.some((q) => q.field === 'listing') && <><dt>The listing said</dt><dd><Marked text={m.listing} quotes={m.quotes} field="listing" /></dd></>}
        {n && <><dt>Note to the buyer</dt><dd>{n.note_to_payer}</dd></>}
      </dl>
    </section>
  );
}

function Fix({ run, owner, reload }: { run: WhoElseRun; owner?: boolean; reload: () => void }) {
  const skus = [...new Set(run.members.map((m) => m.sku))];
  const proposed = run.corrections.find((c) => !c.at);
  const seedSku = run.members.find((m) => m.incident_id === run.seed)?.sku ?? skus[0];
  const [sku, setSku] = useState<string | null>(null), [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const at = sku ?? proposed?.sku ?? seedSku, value = text ?? (proposed?.sku === at ? proposed.text : '');
  const apply = async () => {
    setBusy(true); setErr(null);
    try { await api(`/api/who-else/run/${encodeURIComponent(run.id)}/correct`, { method: 'POST', json: { sku: at, text: value } }); setText(null); setSku(null); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); reload(); }
  };
  const lines = trialLines(run);
  return (
    <section className="jd-whoelse-fix">
      <h3>Fix the listing</h3>
      <p className="jd-muted">The shopping agent reads a corrected listing from then on. Records already made keep the listing it saw.</p>
      {run.corrections.filter((c) => c.at).map((c) => <p key={c.sku + c.at}>{RECORDED} {c.sku}, corrected {day(c.at!)}: {c.text}</p>)}
      {owner ? <>
        <div className="jd-row">
          <select aria-label="Listing to correct" value={at} onChange={(e) => { setSku(e.target.value); setText(null); }}>{skus.map((s) => <option key={s}>{s}</option>)}</select>
          <button type="button" className="jd-btn" disabled={busy || !value.trim()} onClick={apply}>{busy ? 'Applying, then running 3 trials...' : 'Apply the correction'}</button>
        </div>
        <textarea className="jd-whoelse-text" rows={3} aria-label="Corrected listing" value={value} onChange={(e) => setText(e.target.value)} />
      </> : proposed && <p className="jd-muted">Proposed for {proposed.sku}, not applied: {proposed.text}</p>}
      {err && <div className="jd-result jd-err">{err}</div>}
      {run.trials.length > 0 && <>
        <h3>The same ask, {run.trials.length} times, no order placed</h3>
        {lines.map((l) => <p key={l} className="jd-attn">{l}</p>)}
        <dl className="jd-facts">{run.trials.map((t, i) => <div key={t.at + i}><dt>Trial {i + 1}: {t.outcome === 'bought' ? `bought ${t.sku}` : 'bought nothing'}</dt><dd>{t.reason}</dd></div>)}</dl>
      </>}
    </section>
  );
}

export function WhoElseWidget() {
  const owner = usePoll<{ owner?: boolean }>('/api/status', 60000).data?.owner;
  const top = usePoll<{ latest: WhoElseRun | null; score: WhoElseScore; left: number }>('/api/who-else', 30000);
  const incidents = usePoll<IncidentSummary[]>('/api/incidents', 60000);
  const latest = top.data?.latest ?? null;
  // Read through the run route: it reads hold and refund states fresh, so a hold that expires shows here.
  const fresh = usePoll<WhoElseRun>(latest ? `/api/who-else/run/${encodeURIComponent(latest.id)}` : null, 15000, [latest?.id]);
  const run = fresh.data?.id === latest?.id ? fresh.data : latest;
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<Bucket>>(new Set(['not_same']));
  const [picked, setPicked] = useState<string | null>(null);
  const [seed, setSeed] = useState('');
  const [ran, setRan] = useState<string | null>(null); // the run this session started; any other on screen is a recorded one
  const [busy, setBusy] = useState<string | null>(null), [err, setErr] = useState<string | null>(null);
  const none = !!run && noSharedMistake(run);
  const shown = useMemo(() => none ? new Set<Bucket>() : closed, [none, closed]); // nothing but Not the same: what was checked stays open
  const rows = useMemo(() => run ? whoElseRows(run, dropped, shown) : [], [run, dropped, shown]);
  const total = useMemo(() => run && run.members.some((m) => m.bucket === 'silent') ? [keptTotal(run, dropped)] : [], [run, dropped]);
  const live = run?.id === ran && run.mode === 'live';
  const plan = run ? toPlan(run, dropped) : [];
  const pending = run?.remedies.filter((r) => r.hold_status === 'pending') ?? [];
  const seeds = useMemo(() => (incidents.data ?? []).filter((i) => !i.id.startsWith('decline-')).sort((a, b) => Number(!!b.dispute_id) - Number(!!a.dispute_id)), [incidents.data]);
  const chosen = seed || seeds[0]?.id || '';
  const reload = () => { top.reload(); fresh.reload(); };
  const act = async (name: string, path: string, json: unknown) => {
    setBusy(name); setErr(null);
    try { return await api<WhoElseRun>(path, { method: 'POST', json }); }
    catch (e: any) { setErr(e.message); return null; }
    finally { setBusy(null); reload(); }
  };
  const find = async () => { const r = await act('find', '/api/who-else/run', { seed: chosen }); if (r?.id) { setRan(r.id); setDropped(new Set()); setPicked(null); } };
  const planIt = () => act('plan', `/api/who-else/run/${encodeURIComponent(run!.id)}/plan`, { captures: plan.map((m) => m.capture_id) });
  const approveAll = () => { if (confirm(`Approve ${pending.length} refund${pending.length === 1 ? '' : 's'}? They run one at a time and it can finish part way. PayPal's answer shows on each row.`)) act('approve', `/api/who-else/run/${encodeURIComponent(run!.id)}/approve-all`, {}); };

  const columns = useMemo<ColDef<WhoElseRow>[]>(() => [
    {
      field: 'keep', headerName: 'Keep', width: 72, hide: !owner, cellDataType: 'boolean', sortable: false,
      editable: (p) => !!p.data?.can_keep,
      cellRendererSelector: (p) => p.data?.kind === 'member' && p.data.bucket === 'silent' ? { component: 'agCheckboxCellRenderer' } : { component: () => null },
    },
    {
      field: 'label', headerName: 'Purchase', width: 216, cellRenderer: (p: { data?: WhoElseRow }) => {
        const r = p.data!;
        if (r.kind === 'total') return <strong>{r.label}</strong>;
        if (r.kind === 'group') return <button type="button" className="jd-whoelse-toggle" aria-expanded={r.open} onClick={() => setClosed((c) => { const n = new Set(c); if (n.has(r.bucket)) n.delete(r.bucket); else n.add(r.bucket); return n; })}><span aria-hidden="true">{r.open ? '-' : '+'}</span> {r.label}</button>;
        return <a className="jd-linkish" href={`/incident/${encodeURIComponent(r.member!.incident_id)}`} target="_blank" rel="noreferrer">...{r.member!.incident_id.slice(-6)}</a>;
      },
    },
    { field: 'remaining', headerName: 'Left to refund', width: 120, type: 'rightAligned', cellClass: 'jd-num', valueFormatter: dollars },
    { field: 'paid', headerName: 'Paid', width: 92, type: 'rightAligned', cellClass: 'jd-num', valueFormatter: dollars },
    { field: 'refunded', headerName: 'Already back', width: 112, type: 'rightAligned', cellClass: 'jd-num', valueFormatter: dollars },
    { colId: 'sku', headerName: 'Bag', width: 92, valueGetter: (p) => p.data?.member?.sku ?? '' },
    {
      colId: 'paypal', headerName: 'PayPal says', flex: 1, minWidth: 176, valueGetter: (p) => p.data?.member?.payment_status ?? '',
      cellRenderer: (p: { data?: WhoElseRow }) => {
        const m = p.data?.member;
        if (!m) return null;
        return m.payment_status === null ? <span className="jd-attn">{RECORDED} PayPal unread</span> : <span>{live ? LIVE : RECORDED} {m.payment_status}</span>;
      },
    },
    { colId: 'fingerprint', headerName: 'Fingerprint', width: 150, valueGetter: (p) => p.data?.member?.fingerprint ?? '' },
    {
      colId: 'hold', headerName: 'Hold', flex: 1, minWidth: 196, valueGetter: (p) => p.data?.remedy?.hold_status ?? '', tooltipValueGetter: (p) => HOLD_STATUS[p.value] ?? p.value,
      cellRenderer: (p: { data?: WhoElseRow }) => {
        const s = p.data?.remedy?.hold_status;
        return s ? <span className={BAD_HOLD.has(s) ? 'jd-whoelse-bad' : undefined}>{RECORDED} {HOLD_STATUS[s] ?? s}</span> : null;
      },
    },
    {
      colId: 'refund', headerName: 'PayPal refund', width: 196, valueGetter: (p) => p.data?.remedy?.refund_id ?? '',
      cellRenderer: (p: { data?: WhoElseRow }) => { const r = p.data?.remedy; return r?.refund_id ? <span>{LIVE} {r.refund_id}{r.refund_status ? `, ${r.refund_status}` : ''}</span> : null; },
    },
  ], [owner, live]);

  const score = top.data?.score;
  const subtitle = !top.data ? 'Loading' : score ? `${score.runs} run${score.runs === 1 ? '' : 's'} · ${score.silent_found} never complained, found · ${score.refunds_confirmed} of ${score.refunds_proposed} proposed refunds confirmed by PayPal` : undefined;
  const open = picked ? rows.find((r) => r.id === picked && r.kind === 'member') : undefined;
  return (
    <Panel title="Who else?" subtitle={subtitle} hug>
      {top.error && <div className="jd-result jd-err">{top.error}</div>}
      {owner
        ? <div className="jd-row">
            <select className="jd-ellipsis" aria-label="Start from" value={chosen} onChange={(e) => setSeed(e.target.value)}>{seeds.map((i) => <option key={i.id} value={i.id}>{i.dispute_id ? 'Disputed' : 'Not disputed'} · ...{i.id.slice(-6)} · {i.title}</option>)}</select>
            <button type="button" className="jd-btn" disabled={!chosen || !!busy || !top.data?.left} onClick={find}>{busy === 'find' ? 'Reading every public purchase...' : 'Who else?'}</button>
            <span className="jd-muted">{top.data?.left ?? 0} left today</span>
          </div>
        : <p className="jd-muted">Read-only here. Only the owner can plan and approve. To run the finder yourself, open <a className="jd-linkish" href="/who-else" target="_blank" rel="noreferrer">the Who else? page</a>.</p>}
      {top.data && !run && <p className="jd-muted">No run yet.</p>}
      {run && <>
        <div className="jd-whoelse-cause">
          <p>{live ? LIVE : RECORDED} <span className="jd-muted">{live ? 'Read just now.' : `Latest finished run, from ${day(run.at)}.`}</span></p>
          {none && <p><strong>No shared mistake found.</strong> {run.members.length} purchases checked, and none shows this mistake. There's nothing to plan.</p>}
          <p>{run.cause.summary}</p>
          {run.cause.quotes.map((q, i) => <p key={i} className="jd-muted">{FIELD[q.field]}: <mark>{q.text}</mark></p>)}
        </div>
        <p className="jd-muted">Claude only says same, not same or unsure. Code picks the group, and the amount is what PayPal shows left to refund. Click a row for the agent's words.</p>
        {owner && !none && <>
          <div className="jd-row">
            <button type="button" className="jd-btn jd-primary" disabled={!plan.length || !!busy} onClick={planIt}>{busy === 'plan' ? 'Holding...' : `Plan refunds (${plan.length})`}</button>
            <button type="button" className="jd-btn" disabled={!pending.length || !!busy} onClick={approveAll}>{busy === 'approve' ? 'Approving one at a time...' : `Approve all (${pending.length})`}</button>
          </div>
          <p className="jd-muted">Plan makes one held refund per kept row, and each waits for you like any other hold. Approve all runs them one at a time with the usual re-checks. It isn't all or nothing: it can finish part way, and each row shows how it ended.</p>
        </>}
        {err && <div className="jd-result jd-err">{err}</div>}
        <div className="jd-grid jd-whoelse">
          <AgGridReact<WhoElseRow>
            theme={gridTheme}
            rowData={rows}
            pinnedBottomRowData={total}
            columnDefs={columns}
            defaultColDef={{ sortable: true, resizable: true }}
            getRowId={(p) => p.data.id}
            postSortRows={(p) => { p.nodes.sort((a, b) => inGroups(a.data!, b.data!)); }}
            getRowClass={(p) => p.data?.kind === 'group' ? `jd-whoelse-group${p.data.bucket === 'silent' ? ' jd-whoelse-focus' : ''}` : p.data?.bucket === 'silent' && p.data.kind === 'member' ? 'jd-whoelse-focus' : undefined}
            rowClassRules={{ 'jd-row-selected': (p) => p.data?.id === picked }}
            onCellValueChanged={(e) => { const c = e.data.member?.capture_id; if (c) setDropped((d) => { const n = new Set(d); if (e.newValue) n.delete(c); else n.add(c); return n; }); }}
            onRowClicked={(e) => { if (e.data?.kind === 'member') setPicked(e.data.id); }}
            domLayout="autoHeight"
            tooltipShowDelay={300}
          />
        </div>
        {open && <Detail r={open} seed={run.seed} />}
        {!none && <Fix key={run.id} run={run} owner={owner} reload={reload} />}
      </>}
      <p className="jd-muted">Sandbox only, no real money. Every purchase is one sandbox test buyer, and our own script filed the disputes. The agent's mistake is real: its words are quoted as recorded when it bought. Airlines differ, so a bag may not fit. PayPal confirms payments and refunds. It doesn't confirm the mistake.</p>
    </Panel>
  );
}
