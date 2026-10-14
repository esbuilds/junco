import { useEffect, useState } from 'react';
import { goToPage, selectCase } from '../store';
import { Panel } from './Panel';

// v3.14 item 5, cross-filtering: the disputes behind the Insights charts, read through Studio's data engine
// (widgetApi.getData), so the page's button filters and a click on a chart narrow this list the same way they narrow the
// other charts. Clicking a row opens the case on the Desk.
const COLS = ['dispute', 'reason', 'status', 'junco_says', 'amount'] as const;

export function MatchingWidget({ widgetApi }: { widgetApi: any }) {
  const [rows, setRows] = useState<Record<string, any>[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
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
  return (
    <Panel title="Matching disputes" subtitle={rows ? `${rows.length} ${rows.length === 1 ? "matches" : "match"} the filters on this page; click a chart or a filter to narrow it` : "Loading"}>
      {err && <div className="jd-result jd-err">{err}</div>}
      <div className="jd-table-wrap">
        <table className="jd-table">
          <thead><tr><th>Case</th><th>Reason</th><th>Status</th><th>JUNCO says</th><th>Amount</th></tr></thead>
          <tbody>
            {(rows ?? []).map((r) => {
              const id = String(val(r, 'dispute'));
              return (
                <tr key={id}>
                  <td><button type="button" className="jd-linkish" onClick={() => { goToPage('desk'); selectCase(id); }}>{id}</button></td>
                  <td>{val(r, 'reason')}</td><td>{val(r, 'status')}</td><td>{val(r, 'junco_says')}</td><td>${Number(val(r, 'amount')).toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
