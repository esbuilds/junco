import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, type ColDef, type IRowNode } from 'ag-grid-community';
import type { IncidentSummary } from '../../../src/incident-types';
import type { Bucket, Quote, QuoteField, SeedNote, WhoElseRun, WhoElseScore } from '../../../src/whoelse-types';
import { gridTheme } from '../theme';
import { api, HOLD_STATUS, money } from '../api';
import { usePoll } from '../store';
import { detailUnderRow, inGroups, keptTotal, noOtherLine, noOtherPurchase, quoteParts, trialLines, whoElseRows, whoElseSummary, type StepId, type WhoElseRow } from '../ui';
import { ConfirmDialog } from './ConfirmDialog';

ModuleRegistry.registerModules([AllCommunityModule]);

// Who else?: the result first, then the path it walks: Found, Plan, Approve, Fix the listing. The AG Grid under it holds
// every purchase, grouped by what code decided, with money totals per group, and a row opens in place for its records.
// All of it goes through the desk's routes; nothing here picks an amount or a capture. Visitors read, the owner acts.
const rowTheme = gridTheme.withParams({ rowHeight: 56, headerHeight: 36, cellHorizontalPaddingScale: 0.8 });
const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches; // read once, as App does
const LIVE = <span className="jd-mode jd-mode-live">LIVE</span>;
const RECORDED = <span className="jd-mode jd-mode-recorded">RECORDED</span>;
const BAD_HOLD = new Set(['failed', 'unknown', 'stale', 'expired']);
const STEPS: [StepId, string][] = [['found', 'Found'], ['plan', 'Plan'], ['approve', 'Approve'], ['fix', 'Fix the listing']];
const day = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const Marked = ({ text, quotes, field }: { text: string; quotes: Quote[]; field: QuoteField }) => <>{quoteParts(text, quotes, field).map((p, i) => p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>)}</>;
const dollars = (p: { value?: number | null }) => p.value == null ? '' : money(p.value);
const Pill = ({ s }: { s?: WhoElseRow['status'] }) => s ? <span className={`jd-wel-pill jd-wel-pill-${s.tone}`}>{s.label}</span> : null;
const agentWords = (r: WhoElseRow) => r.member!.quotes.filter((q) => q.field === 'reason').map((q) => q.text);

// A row opened in place: AG Grid's detail rows are Enterprise, so this is a full-width row that reports its own height.
function RowDetail({ r, seed, live, node, api: grid }: { r: WhoElseRow; seed: string; live: boolean; node: IRowNode; api: any }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const h = ref.current?.offsetHeight; if (h && node.rowHeight !== h) { node.setRowHeight(h); grid.onRowHeightChanged(); } });
  const m = r.member!, n = r.remedy, told = r.notice, Mode = live ? LIVE : RECORDED;
  return (
    <div ref={ref} className="jd-wel-detail">
      <div className="jd-wel-words">
        <p>{m.why}</p>
        <dl>
          <dt>The buyer asked</dt><dd><Marked text={m.instruction} quotes={m.quotes} field="instruction" /></dd>
          <dt>The agent said</dt><dd><Marked text={m.reason} quotes={m.quotes} field="reason" /></dd>
          {m.quotes.some((q) => q.field === 'listing') && <><dt>The listing said</dt><dd><Marked text={m.listing} quotes={m.quotes} field="listing" /></dd></>}
          {told && <><dt>Their agent {told.outcome}</dt><dd>{told.reason}</dd></>}
          {n && <><dt>Note to the buyer</dt><dd>{n.note_to_payer}</dd></>}
        </dl>
      </div>
      <dl className="jd-wel-facts">
        {m.sku && <><dt>Bag</dt><dd>{m.sku}</dd></>}
        <dt>Paid</dt><dd>{money(r.paid)}</dd>
        <dt>Refunded</dt><dd>{money(r.refunded)}</dd>
        <dt>Left to refund</dt><dd>{money(r.remaining)}</dd>
        <dt>Fingerprint</dt><dd>{m.fingerprint}</dd>
        <dt>{Mode} PayPal said</dt><dd>{m.payment_status ?? (m.sku ? 'PayPal unread' : 'No payment')}{n?.refund_id ? ', before this refund' : ''}</dd>
        {n?.hold_status && <><dt>{RECORDED} Hold</dt><dd className={BAD_HOLD.has(n.hold_status) ? 'jd-whoelse-bad' : undefined}>{HOLD_STATUS[n.hold_status] ?? n.hold_status}</dd></>}
        {n?.refund_id && <><dt>{LIVE} PayPal refund</dt><dd>{n.refund_id}{n.refund_status ? `, ${n.refund_status}` : ''}</dd></>}
      </dl>
      <p className="jd-wel-open"><a href={`/incident/${encodeURIComponent(m.incident_id)}`} target="_blank" rel="noreferrer">Open the incident{m.incident_id === seed ? ', where this started' : ''}</a></p>
    </div>
  );
}

// The end of the story: the correction, then what the agent does with it, including when it moves to another bag.
function Fix({ run, owner, reload }: { run: WhoElseRun; owner?: boolean; reload: () => void }) {
  const skus = [...new Set(run.members.map((m) => m.sku).filter(Boolean))];
  const applied = run.corrections.filter((c) => c.at), proposed = run.corrections.find((c) => !c.at);
  const seedSku = run.members.find((m) => m.incident_id === run.seed)?.sku || skus[0];
  const moved = [...new Set(run.trials.filter((t) => t.outcome === 'bought' && !applied.some((c) => c.sku === t.sku)).map((t) => t.sku!))];
  const [sku, setSku] = useState<string | null>(null), [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null), [more, setMore] = useState(false);
  const at = sku ?? moved[0] ?? proposed?.sku ?? seedSku, value = text ?? (proposed?.sku === at ? proposed.text : '');
  const apply = async () => {
    setBusy(true); setErr(null);
    try { await api(`/api/who-else/run/${encodeURIComponent(run.id)}/correct`, { method: 'POST', json: { sku: at, text: value } }); setText(null); setSku(null); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); reload(); }
  };
  return (
    <div className="jd-wel-fix">
      {applied.map((c) => <div key={c.sku + c.at} className="jd-wel-callout"><h4>{c.sku} now says</h4><p>{c.text}</p><small>Corrected {day(c.at!)}. Records already made keep the listing the agent saw.</small></div>)}
      {run.trials.length > 0 && <div className="jd-wel-trials">
        <h4>The same ask, {run.trials.length} time{run.trials.length === 1 ? '' : 's'}, no order placed</h4>
        <ol>{run.trials.map((t, i) => <li key={t.at + i} className={t.outcome === 'bought' ? 'jd-wel-trial-bought' : undefined}><strong>{t.outcome === 'bought' ? `Bought ${t.sku}` : 'Bought nothing'}</strong><span>{t.reason}</span></li>)}</ol>
        {trialLines(run).map((l) => <p key={l} className="jd-wel-finding">{l}</p>)}
      </div>}
      {owner && applied.length > 0 && !moved.length && !proposed && !more ? <button type="button" className="jd-wel-link" onClick={() => setMore(true)}>Correct another listing</button>
      : owner ? <div className="jd-wel-edit">
        <label className="jd-field">{moved.length ? 'Correct the next listing' : 'The correction the agent will read'}
          <textarea rows={3} value={value} onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="jd-wel-actions">
          {skus.length > 1 && <select aria-label="Listing to correct" value={at} onChange={(e) => { setSku(e.target.value); setText(null); }}>{skus.map((s) => <option key={s}>{s}</option>)}</select>}
          {value.trim() && <button type="button" className="jd-btn jd-primary" disabled={busy} onClick={apply}>{busy ? 'Applying, then 3 trials...' : `Correct ${at}, then run 3 trials`}</button>}
        </div>
      </div> : proposed && <div className="jd-wel-callout"><h4>Proposed for {proposed.sku}, not applied</h4><p>{proposed.text}</p></div>}
      {err && <div className="jd-result jd-err">{err}</div>}
    </div>
  );
}

export function WhoElseWidget() {
  const owner = usePoll<{ owner?: boolean }>('/api/status', 60000).data?.owner;
  const top = usePoll<{ latest: WhoElseRun | null; score: WhoElseScore; left: number; agents_left: number; seeds: SeedNote[] }>('/api/who-else', 30000);
  const incidents = usePoll<IncidentSummary[]>(owner ? '/api/incidents' : null, 60000);
  const latest = top.data?.latest ?? null;
  // Read through the run route: it reads hold and refund states fresh, so a hold that expires shows here.
  const fresh = usePoll<WhoElseRun>(latest ? `/api/who-else/run/${encodeURIComponent(latest.id)}` : null, 15000, [latest?.id]);
  const run = fresh.data?.id === latest?.id ? fresh.data : latest;
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<Bucket>>(new Set(['not_same']));
  const [picked, setPicked] = useState<string | null>(null);
  const [opened, setOpened] = useState<StepId | null>(null); // a step the owner opened; otherwise the current one
  const [editing, setEditing] = useState(false), [seed, setSeed] = useState('');
  const [note, setNote] = useState<string | null>(null); // the owner's edit; null shows what's saved
  const [ran, setRan] = useState<string | null>(null); // the run this session started; any other on screen is a recorded one
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null), [err, setErr] = useState<string | null>(null);
  const none = !!run && noOtherPurchase(run);
  const shown = useMemo(() => none ? new Set<Bucket>() : closed, [none, closed]); // nothing else matched: what was checked stays open
  const rows = useMemo(() => run ? whoElseRows(run, dropped, shown, picked) : [], [run, dropped, shown, picked]);
  const sum = useMemo(() => run && whoElseSummary(run, dropped), [run, dropped]);
  const total = useMemo(() => run && owner && sum?.plan.length ? [keptTotal(run, dropped)] : [], [run, owner, sum, dropped]);
  const live = run?.id === ran && run.mode === 'live';
  const canKeep = !!owner && rows.some((r) => r.can_keep);
  const notes = top.data?.seeds ?? [];
  const purchases = useMemo(() => (incidents.data ?? []).filter((i) => !i.id.startsWith('decline-')).sort((a, b) => Number(!!b.dispute_id) - Number(!!a.dispute_id)), [incidents.data]);
  const chosen = seed || run?.seed || notes[0]?.incident_id || purchases[0]?.id || ''; // the picker follows the run on screen until the owner picks another
  const saved = notes.find((s) => s.incident_id === chosen)?.text ?? '';
  const noteText = note ?? saved;
  const runsLeft = top.data?.left ?? 0, agentsLeft = top.data?.agents_left ?? 0;
  const reload = () => { top.reload(); fresh.reload(); };
  const act = async (name: string, path: string, json: unknown) => {
    setBusy(name); setErr(null);
    try { return await api<WhoElseRun>(path, { method: 'POST', json }); }
    catch (e: any) { setErr(e.message); return null; }
    finally { setBusy(null); reload(); }
  };
  const saveNote = async () => { await act('note', '/api/who-else/note', { seed: chosen, text: noteText.trim() }); setNote(null); };
  const find = async (from: string) => { const r = await act('find', '/api/who-else/run', { seed: from }); if (r?.id) { setRan(r.id); setDropped(new Set()); setPicked(null); setOpened(null); setEditing(false); setSeed(''); } };
  const tell = async () => {
    setOpened(null);
    const r = await act('tell', `/api/who-else/run/${encodeURIComponent(run!.id)}/notify`, { captures: sum!.tell.map((m) => m.capture_id) }) as (WhoElseRun & { skipped?: { why: string }[] }) | null;
    if (r?.skipped?.length) setErr([...new Set(r.skipped.map((x) => x.why))].join(' '));
  };
  const planIt = () => { setOpened(null); return act('plan', `/api/who-else/run/${encodeURIComponent(run!.id)}/plan`, { captures: sum!.plan.map((m) => m.capture_id) }); };
  const approveAll = async () => { await act('approve', `/api/who-else/run/${encodeURIComponent(run!.id)}/approve-all`, {}); setAsking(false); setOpened(null); };
  const toggle = (b: Bucket) => setClosed((c) => { const n = new Set(c); if (n.has(b)) n.delete(b); else n.add(b); return n; });

  const columns = useMemo<ColDef<WhoElseRow>[]>(() => {
    const purchase = (r: WhoElseRow) => <span className="jd-wel-buy"><a href={`/incident/${encodeURIComponent(r.member!.incident_id)}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>...{r.member!.incident_id.slice(-6)}</a>{r.member!.incident_id === run?.seed && <small>Started here</small>}</span>;
    const words = (r: WhoElseRow) => { const q = agentWords(r); return q.length ? <span className="jd-wel-quote">{q.map((t, i) => <mark key={i}>{t}</mark>)}</span> : <span className="jd-wel-why">{r.member!.why}</span>; };
    return [
      {
        field: 'keep', headerName: '', width: 44, hide: !canKeep, cellDataType: 'boolean', sortable: false, resizable: false, headerTooltip: 'Keep in the plan',
        editable: (p) => !!p.data?.can_keep,
        cellRendererSelector: (p) => p.data?.can_keep ? { component: 'agCheckboxCellRenderer' } : { component: () => null },
      },
      {
        field: 'label', headerName: 'Purchase', width: narrow ? undefined : 124, flex: narrow ? 1 : undefined, sortable: false, autoHeight: narrow, wrapText: narrow,
        colSpan: (p) => !narrow && (p.data?.kind === 'group' || p.data?.kind === 'total') ? 2 : 1,
        cellRenderer: (p: { data?: WhoElseRow }) => {
          const r = p.data!;
          if (r.kind === 'total') return <strong>{r.label}</strong>;
          if (r.kind === 'group') return <button type="button" className="jd-wel-group" aria-expanded={r.open} onClick={() => toggle(r.bucket)}><i aria-hidden="true" />{r.label}</button>;
          return narrow ? <span className="jd-wel-stack">{purchase(r)}{words(r)}<Pill s={r.status} /></span> : purchase(r);
        },
      },
      { colId: 'words', headerName: 'What the agent said', flex: 1, minWidth: 240, hide: narrow, sortable: false, cellRenderer: (p: { data?: WhoElseRow }) => (p.data?.kind === 'member' ? words(p.data) : null) },
      { field: 'remaining', headerName: narrow ? 'Left' : 'Left to refund', width: narrow ? 84 : 128, type: 'rightAligned', cellClass: 'ag-right-aligned-cell', valueFormatter: dollars }, // a cellClass replaces the type's own
      { colId: 'status', headerName: 'Status', width: 172, hide: narrow, valueGetter: (p) => p.data?.status?.label ?? '', cellRenderer: (p: { data?: WhoElseRow }) => <Pill s={p.data?.status} /> },
    ];
  }, [canKeep, run?.seed]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = opened ?? sum?.current;
  const heldRows = run?.remedies.filter((r) => r.hold_status === 'pending') ?? [];
  const heldTotal = heldRows.reduce((n, r) => n + Number(r.amount), 0);
  const heldNotes = [...new Set(heldRows.map((r) => r.note_to_payer))];
  const quote = run?.cause.quotes.find((q) => q.field === 'reason') ?? run?.cause.quotes[0];
  const score = top.data?.score;
  return (
    <section className="jd-panel jd-panel-hug jd-wel">
      {top.error && <div className="jd-result jd-err">{top.error}</div>}

      {top.data && !run && <div className="jd-wel-empty">
        <h1>Nothing has been run yet</h1>
        <p>{owner ? 'Say what went wrong on one purchase, and Claude finds the others that show it.' : 'The owner says what went wrong on one purchase, and Claude finds the others that show it.'}</p>
        {owner && !editing && <button type="button" className="jd-btn jd-primary" onClick={() => setEditing(true)}>Start from a purchase</button>}
        {!owner && <a className="jd-btn" href="/who-else" target="_blank" rel="noreferrer">Open the public page</a>}
      </div>}

      {run && sum && <>
        <header className="jd-wel-meta">
          <span>{live ? LIVE : RECORDED}</span>
          <span>{live ? 'Read just now' : `Latest finished run, ${day(run.at)}`}{!runsLeft && top.data ? ". Today's runs are used up" : ''}</span>
          <span className="jd-grow" />
          {owner && !editing && runsLeft > 0 && <button type="button" className="jd-wel-link" disabled={!!busy} onClick={() => find(run.seed)}>{busy === 'find' ? 'Looking for other purchases...' : 'Run again'}</button>}
          {owner && !editing && <button type="button" className="jd-wel-link" onClick={() => setEditing(true)}>Another purchase</button>}
          {owner === false && <a href="/who-else" target="_blank" rel="noreferrer">Run it on the public page</a>}
        </header>

        <div className="jd-wel-top">
          <div className="jd-wel-result">
            {none ? <>
              <h1 className="jd-wel-none">No other purchase shows this problem</h1>
              <p className="jd-wel-sub">{noOtherLine(run)}</p>
            </> : <>
              <p className="jd-wel-big"><b>{sum.silent}</b> more purchase{sum.silent === 1 ? '' : 's'} show{sum.silent === 1 ? 's' : ''} this problem, and nobody complained</p>
              <dl className="jd-wel-stats">
                <div><dd>{money(sum.left)}</dd><dt>left to refund</dt></div>
                <div><dd>{sum.refunded}</dd><dt>refunded, confirmed by PayPal</dt></div>
                {sum.complained > 0 && <div><dd>{sum.complained}</dd><dt>also complained</dt></div>}
                {sum.asked > 0 && <div><dd>{sum.asked}</dd><dt>purchase{sum.asked === 1 ? '' : 's'} where their agent asked</dt></div>}
                {sum.declined > 0 && <div><dd>{sum.declined}</dd><dt>purchase{sum.declined === 1 ? '' : 's'} where their agent declined</dt></div>}
              </dl>
              {sum.failed.length > 0 && <p className="jd-wel-alert">{sum.failed.length} refund{sum.failed.length === 1 ? '' : 's'} didn't run. The rows below say why.</p>}
            </>}
          </div>
          <figure className="jd-wel-card">
            <figcaption>What the owner says went wrong</figcaption>
            <blockquote>{run.cause.summary}</blockquote>
            {quote && <p className="jd-wel-said"><span>The agent said</span><mark>{quote.text}</mark></p>}
          </figure>
        </div>

        {!none && <>
          <ol className="jd-wel-path" aria-label="The path">
            {STEPS.map(([id, name], i) => (
              <li key={id} className={`${sum.current === id ? 'jd-wel-now' : sum.done[id] ? 'jd-wel-done' : ''}${step === id ? ' jd-wel-open-step' : ''}`}>
                <button type="button" aria-expanded={step === id} onClick={() => setOpened(step === id && opened ? null : id)}>
                  <i aria-hidden="true">{i + 1}</i>
                  <span><b>{name}</b><small>{sum.lines[id]}</small></span>
                </button>
              </li>
            ))}
          </ol>

          <div className="jd-wel-step">
            {step === 'found' && <p>The owner named the problem on purchase ...{run.seed.slice(-6)}. Claude read the others and code sorted them into the groups below.</p>}
            {step === 'plan' && (sum.plan.length ? <>
              <div className="jd-wel-choice">
                <div>
                  <h4>Plan refunds</h4>
                  <p>You choose. Each refund waits for your approval.</p>
                  <div className="jd-wel-callout"><h4>What each buyer will read through PayPal</h4><p>{run.draft_note}</p></div>
                  {owner && <button type="button" className="jd-btn jd-primary" disabled={!!busy} onClick={planIt}>{busy === 'plan' ? 'Holding...' : `Plan ${sum.plan.length} refund${sum.plan.length === 1 ? '' : 's'}`}</button>}
                </div>
                {sum.tell.length > 0 && <div>
                  <h4>Tell their agents</h4>
                  <p>Each purchase's own agent reads the notice and decides whether to ask. If it asks, the refund still waits for your approval.{owner && ` ${sum.tell.length} purchase${sum.tell.length === 1 ? '' : 's'}, ${agentsLeft ? `${agentsLeft} agent${agentsLeft === 1 ? '' : 's'} left today` : "today's agents are used up"}.`}</p>
                  <div className="jd-wel-callout"><h4>What each agent will read</h4><p>{run.notice}</p></div>
                  {owner && <button type="button" className="jd-btn jd-primary" disabled={!!busy || !agentsLeft} onClick={tell}>{busy === 'tell' ? 'Their agents are reading...' : 'Tell their agents'}</button>}
                </div>}
              </div>
              {owner ? <p>Untick a row to leave it out. Each agent is a test buyer's agent run by this demo, in the same process as the desk, so you can see both sides.</p> : <p>The owner decides which of these to refund, or tells their agents. Each agent is a test buyer's agent run by this demo.</p>}
            </> : <p>{run.remedies.length ? 'Every kept purchase has its refund planned.' : sum.declined ? 'Their agents declined, so nothing is left to plan.' : 'Nothing is kept for the plan.'}</p>)}
            {step === 'approve' && (sum.held.length ? (owner ? <div className="jd-wel-actions">
              <button type="button" className="jd-btn jd-primary" disabled={!!busy} onClick={() => setAsking(true)}>Approve {sum.held.length} refund{sum.held.length === 1 ? '' : 's'}</button>
              <span>{money(heldTotal)} in all. They run one at a time and it can finish part way.</span>
            </div> : <p>{sum.held.length} refund{sum.held.length === 1 ? ' is' : 's are'} waiting for the owner.</p>)
              : <p>{sum.lines.approve}.</p>)}
            {step === 'fix' && <Fix key={run.id} run={run} owner={owner} reload={reload} />}
          </div>
        </>}
      </>}

      {owner && editing && <div className="jd-wel-seed">
        <div className="jd-wel-seed-head"><h2>Start from another purchase</h2><button type="button" className="jd-wel-link" onClick={() => { setEditing(false); setSeed(''); setNote(null); }}>Close</button></div>
        <label className="jd-field">Purchase
          <select className="jd-ellipsis" value={chosen} onChange={(e) => { setSeed(e.target.value); setNote(null); }}>{purchases.map((i) => <option key={i.id} value={i.id}>{i.dispute_id ? 'Disputed' : 'Not disputed'}, ...{i.id.slice(-6)}, {i.title}</option>)}</select>
        </label>
        <label className="jd-field">What went wrong, in your words. Claude only looks for other purchases that show it.
          <textarea rows={2} value={noteText} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="jd-wel-actions">
          {note !== null && noteText.trim() && <button type="button" className="jd-btn jd-primary" disabled={!!busy} onClick={saveNote}>{busy === 'note' ? 'Saving...' : 'Save the note'}</button>}
          {note === null && saved && runsLeft > 0 && <button type="button" className="jd-btn jd-primary" disabled={!!busy} onClick={() => find(chosen)}>{busy === 'find' ? 'Looking for other purchases...' : 'Who else?'}</button>}
          <span>{note !== null ? 'Save it before you run.' : !saved ? 'This purchase needs a note before it can run.' : runsLeft > 0 ? `${runsLeft} run${runsLeft === 1 ? '' : 's'} left today.` : "Today's runs are used up."}</span>
        </div>
      </div>}
      {err && <div className="jd-result jd-err">{err}</div>}

      {run && <div className="jd-grid jd-whoelse jd-wel-grid">
        <AgGridReact<WhoElseRow>
          theme={rowTheme}
          rowData={rows}
          pinnedBottomRowData={total}
          columnDefs={columns}
          defaultColDef={{ sortable: true, resizable: false, suppressMovable: true }}
          getRowId={(p) => p.data.id}
          postSortRows={(p) => { p.nodes.sort((a, b) => inGroups(a.data!, b.data!)); detailUnderRow(p.nodes); }}
          isFullWidthRow={(p) => p.rowNode.data?.kind === 'detail'}
          fullWidthCellRenderer={(p: any) => <RowDetail r={p.data} seed={run.seed} live={live} node={p.node} api={p.api} />}
          getRowHeight={(p) => (p.data?.kind === 'group' || p.data?.kind === 'total' ? 44 : undefined)}
          getRowClass={(p) => p.data?.kind === 'group' ? `jd-wel-grouprow${p.data.bucket === 'silent' ? ' jd-wel-focus' : ''}` : p.data?.bucket === 'silent' && p.data.kind === 'member' ? 'jd-wel-focus' : undefined}
          rowClassRules={{ 'jd-row-selected': (p) => p.data?.id === picked }}
          onCellValueChanged={(e) => { const c = e.data.member?.capture_id; if (c) setDropped((d) => { const n = new Set(d); if (e.newValue) n.delete(c); else n.add(c); return n; }); }}
          onRowClicked={(e) => { if (e.data?.kind === 'member' && !(e.event?.target as HTMLElement)?.closest?.('input,a')) setPicked((x) => (x === e.data!.id ? null : e.data!.id)); }}
          onCellKeyDown={(e) => { if ((e.event as KeyboardEvent)?.key === 'Enter' && e.data?.kind === 'member') setPicked((x) => (x === e.data!.id ? null : e.data!.id)); }}
          domLayout="autoHeight"
          animateRows={false}
          tooltipShowDelay={300}
        />
      </div>}

      <footer className="jd-wel-fine">
        <details>
          <summary>How this works</summary>
          <p>The owner names the problem. Claude only says whether each other purchase shows it: same, not same or unsure. Code picks the group, and the amount is what PayPal shows left to refund.</p>
          <p>Tell their agents hands each purchase's own shopping agent a notice. It's a test buyer's agent run by this demo, in the same process as the desk, so both sides run here. It sees what its person asked, the budget, what it bought and why, and the notice, and nothing about any other purchase. It asks or declines. Code picks the capture and the amount, and an ask waits for the owner like any refund.</p>
          {score && <p>{score.runs} run{score.runs === 1 ? '' : 's'} so far, {score.purchases_read} purchases read, {score.refunds_confirmed} of {score.refunds_proposed} proposed refunds confirmed by PayPal. Agents told on {score.agents_told} purchase{score.agents_told === 1 ? '' : 's'}: {score.agents_asked} asked, {score.agents_declined} declined.</p>}
        </details>
        <p>Sandbox only, no real money. Every purchase is one sandbox test buyer, and our own script filed the disputes. The agent's mistake is real: its words are quoted as recorded when it bought. Airlines differ, so a bag may not fit. PayPal confirms payments and refunds. It doesn't confirm the mistake.</p>
      </footer>

      {asking && run && <ConfirmDialog title={`Approve ${heldRows.length} refund${heldRows.length === 1 ? '' : 's'}?`} confirm={busy === 'approve' ? 'Approving...' : `Confirm ${money(heldTotal)}`} busy={busy === 'approve'} onConfirm={approveAll} onCancel={() => setAsking(false)}>
        <ul className="jd-wel-confirm">
          {heldRows.map((r) => <li key={r.capture_id}><span>Purchase ...{r.incident_id.slice(-6)}</span><b>{money(Number(r.amount))}</b></li>)}
          <li className="jd-wel-confirm-total"><span>Total</span><b>{money(heldTotal)}</b></li>
        </ul>
        {heldNotes.map((n) => <div key={n} className="jd-wel-callout"><h4>What {heldRows.length === 1 ? 'the buyer' : 'each buyer'} will read through PayPal</h4><p>{n}</p></div>)}
        <p>They run one at a time with the usual re-checks. It can finish part way, and each row shows how it ended.</p>
      </ConfirmDialog>}
    </section>
  );
}
