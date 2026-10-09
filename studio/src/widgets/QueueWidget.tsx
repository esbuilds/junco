import { useEffect, useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GridApi } from 'ag-grid-community';
import { daysLeft, dueText, human, money, REASONS, STATUS, DECISION_LABEL, type CaseRow } from '../api';
import { selectCase, useSelectedCase, usePoll } from '../store';
import { Panel } from './Panel';

ModuleRegistry.registerModules([AllCommunityModule]);

// Same palette as public/index.html (light and dark). AG Grid's theme takes literal colours, not CSS variables,
// so the hex set is picked by colour scheme, as the reference desk does.
const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
const palette = dark
  ? { backgroundColor: '#1d1d1b', foregroundColor: '#ecebe6', headerBackgroundColor: '#262623', borderColor: '#34332f', accentColor: '#5fb497' }
  : { backgroundColor: '#ffffff', foregroundColor: '#1d1d1b', headerBackgroundColor: '#f0eee8', borderColor: '#e3e0d8', accentColor: '#1f5c4a' };
export const gridTheme = themeQuartz.withParams({
  ...palette,
  fontFamily: 'Inter, system-ui, sans-serif',
  rowHeight: 36,
  cellHorizontalPaddingScale: 0.8,
});

export function QueueWidget() {
  const all = usePoll<CaseRow[]>('/api/cases', 10000);
  const { error } = all;
  const data = all.data?.filter((r) => r.status !== 'RESOLVED') ?? null; // resolved cases live in the Outcomes widget
  const selected = useSelectedCase();
  const gridApi = useRef<GridApi<CaseRow> | null>(null);

  const columns = useMemo<ColDef<CaseRow>[]>(() => [
    { field: 'reason', headerName: 'Reason', flex: 1.2, minWidth: 118, valueFormatter: (p) => REASONS[p.value] ?? human(p.value) },
    { field: 'amount', headerName: 'Amount', width: 84, type: 'rightAligned', valueFormatter: (p) => money(p.value, p.data?.currency) },
    {
      field: 'due', headerName: 'Respond in', width: 108,
      comparator: (a: string | null, b: string | null) => (a ? Date.parse(a) : Infinity) - (b ? Date.parse(b) : Infinity),
      cellRenderer: (p: { data?: CaseRow }) => {
        const d = daysLeft(p.data?.due ?? null);
        return <span className={d !== null && d <= 3 ? 'jd-due-soon' : undefined}>{dueText(p.data?.due ?? null)}</span>;
      },
    },
    { field: 'status', headerName: 'Status', flex: 1, minWidth: 116, valueFormatter: (p) => STATUS[p.value] ?? human(p.value) },
    {
      field: 'decision', headerName: 'JUNCO says', width: 130,
      cellRenderer: (p: { value: CaseRow['decision'] }) => p.value
        ? <span className={`jd-badge jd-b-${p.value}`}>{DECISION_LABEL[p.value]}</span>
        : <span className="jd-muted">Not reviewed</span>,
    },
    {
      field: 'pending_holds', headerName: 'Approvals', width: 100,
      cellRenderer: (p: { value: number }) => p.value ? <span className="jd-badge jd-b-held">{p.value} waiting</span> : null,
    },
  ], []);

  // Re-style the selected row when the selection changes elsewhere on the dashboard.
  useEffect(() => { gridApi.current?.redrawRows(); }, [selected]);

  const total = (data ?? []).reduce((s, r) => s + r.amount, 0);
  const cur = data?.[0]?.currency ?? 'USD';

  return (
    <Panel title="Dispute queue" subtitle={data ? `${data.length} open · ${money(total, cur)} in dispute` : 'Loading'} live>
      {error && <div className="jd-result jd-err">{error}</div>}
      <div className="jd-grid">
        <AgGridReact<CaseRow>
          theme={gridTheme}
          rowData={data ?? []}
          loading={!all.data && !error}
          columnDefs={columns}
          getRowId={(p) => p.data.id}
          rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
          rowClassRules={{ 'jd-row-selected': (p) => p.data?.id === selected }}
          onGridReady={(e) => { gridApi.current = e.api; }}
          onRowClicked={(e) => { if (e.data) selectCase(e.data.id); }}
          domLayout="autoHeight"
          overlayNoRowsTemplate='<span class="jd-muted">No disputes in this sandbox account.</span>'
        />
      </div>
    </Panel>
  );
}
