import { Fragment, useEffect, useState } from 'react';
import type { BooksRow } from '../../../src/incident-types';
import { byDifference } from '../../../src/incident-questions';
import { recentView } from '../ui';
import { Clip } from './Clip';
import { Panel } from './Panel';

const SHOW = 8;

// The Books: every AI purchase, read through Studio's data engine like Matching disputes, so the page's filters narrow it.
// Differences stay pinned first whatever order the filters hand back. Each column wears its label: LIVE from PayPal,
// RECORDED from the desk, WHAT-IF for the replay, which re-runs the gate and never reaches PayPal.
const COLS = ['purchase', 'title', 'at', 'paid', 'paypal_status', 'refunds', 'holds', 'fingerprint', 'reconciliation', 'line', 'replay', 'replay_detail'] as const;
const LIVE = <span className="jd-mode jd-mode-live">LIVE</span>;
const RECORDED = <span className="jd-mode jd-mode-recorded">RECORDED</span>;
const WHATIF = <span className="jd-mode jd-mode-what-if">WHAT-IF</span>;

export function BooksWidget({ widgetApi }: { widgetApi: any }) {
  const [rows, setRows] = useState<Record<string, any>[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const fields = (widgetApi?.getSchema?.() ?? []).flatMap((t: any) => t.fields).filter((f: any) => (COLS as readonly string[]).includes(f.externalId));
  // Studio re-renders a widget when its filters change; refetch then, and keep the list only if it actually changed.
  useEffect(() => {
    if (!widgetApi || fields.length < COLS.length) return;
    let live = true;
    widgetApi.getData({ kind: 'flat', fields }).then((r: any) => {
      if (!live) return;
      const next = r.results.rows;
      setRows((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      setErr(null);
    }).catch((e: any) => live && setErr(String(e?.message ?? e)));
    return () => { live = false; };
  });
  const val = (r: Record<string, any>, c: string) => { const k = Object.keys(r).find((x) => x.endsWith(`.${c}`) || x === c); return k ? r[k] : ''; };
  const list = (rows ?? []).map((r) => Object.fromEntries(COLS.map((c) => [c, val(r, c)])) as unknown as BooksRow).sort(byDifference);
  const differ = list.filter((r) => r.reconciliation === 'Differ').length;
  const { shown } = recentView(list, () => false, { tests: false, all, n: SHOW }); // differences sort first, so they're always in the slice
  return (
    <Panel hug title="The Books" subtitle={rows ? `${list.length} AI purchase${list.length === 1 ? '' : 's'} · ${differ} differ` : 'Loading'}
      action={list.length > SHOW ? <button type="button" className="jd-linkish jd-muted" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `View all ${list.length}`}</button> : undefined}>
      {err && <div className="jd-result jd-err">{err}</div>}
      <p className="jd-muted jd-books-note" title="PayPal's side is read at most once a minute per payment. Policy replay re-runs each recorded move under today's policy.">A dispute hold isn't a difference. Policy replay never reaches PayPal.</p>
      <div className="jd-table-wrap">
        <table className="jd-table jd-books">
          <thead><tr>
            <th>Purchase</th><th>{RECORDED} Paid</th><th>{LIVE} PayPal status</th><th>{LIVE} Refunds</th><th>{RECORDED} Desk holds</th><th>{LIVE} Fingerprint</th><th>{LIVE} Reconciliation</th><th>{WHATIF} Policy replay</th>
          </tr></thead>
          <tbody>
            {shown.map((r) => (
              <Fragment key={r.purchase}>
                <tr className={r.reconciliation === 'Agree' ? undefined : `jd-books-flag jd-books-${r.reconciliation.toLowerCase()}`}>
                  <td><a className="jd-linkish" href={`/incident/${encodeURIComponent(r.purchase)}`} target="_blank" rel="noreferrer">...{r.purchase.slice(-6)}</a><div className="jd-muted jd-books-title"><Clip text={r.title} max={36} /></div></td>
                  <td>${Number(r.paid).toFixed(2)}</td><td>{r.paypal_status}</td><td>{r.refunds}</td><td>{r.holds}</td><td>{r.fingerprint}</td>
                  <td className={r.reconciliation === 'Differ' ? 'jd-attn' : r.reconciliation === 'Unread' ? 'jd-muted' : undefined}>{r.reconciliation}</td>
                  <td className="jd-books-replay">{r.replay}{r.replay === 'Changed today' && <div className="jd-books-title">{r.replay_detail}</div>}</td>
                </tr>
                {r.reconciliation !== 'Agree' && <tr className={`jd-books-whyrow jd-books-${r.reconciliation.toLowerCase()}`}><td colSpan={8}><div>{r.line.replace(/^The records differ\. /, '')}</div></td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {rows && !list.length && <p className="jd-muted">No purchases match these filters.</p>}
    </Panel>
  );
}
