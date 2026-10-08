import { useEffect, useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GridApi } from 'ag-grid-community';
import { daysLeft, dueText, human, money, REASONS, STATUS, DECISION_LABEL, type CaseRow } from '../api';
import { selectCase, useSelectedCase, usePoll } from '../store';
import { Panel } from './Panel';

ModuleRegistry.registerModules([AllCommunityModule]);

// Same palette as public/index.html (light and dark), so the Studio desk matches the old desk.
const theme = themeQuartz.withParams({
  backgroundColor: 'var(--jd-surface)',
  foregroundColor: 'var(--jd-ink)',
  headerBackgroundColor: 'var(--jd-surface-2)',
  borderColor: 'var(--jd-line)',
  accentColor: 'var(--jd-accent)',
  fontFamily: 'Inter, system-ui, sans-serif',
  rowHeight: 48,
});

export function QueueWidget() {
  const { data, error } = usePoll<CaseRow[]>('/api/cases', 10000);
  const selected = useSelectedCase();
  const gridApi = useRef<GridApi<CaseRow> | null>(null);

  const columns = useMemo<ColDef<CaseRow>[]>(() => [
    { field: 'reason', headerName: 'Reason', flex: 1.3, minWidth: 150, valueFormatter: (p) => REASONS[p.value] ?? human(p.value) },
    { field: 'amount', headerName: 'Amount', width: 110, type: 'rightAligned', valueFormatter: (p) => money(p.value, p.data?.currency) },
    {
      field: 'due', headerName: 'You respond in', width: 135,
      comparator: (a: string | null, b: string | null) => (a ? Date.parse(a) : Infinity) - (b ? Date.parse(b) : Infinity),
      cellRenderer: (p: { data?: CaseRow }) => {
        const d = daysLeft(p.data?.due ?? null);
        return <span className={d !== null && d <= 3 ? 'jd-due-soon' : undefined}>{dueText(p.data?.due ?? null)}</span>;
      },
    },
    { field: 'status', headerName: 'Status', flex: 1, minWidth: 130, valueFormatter: (p) => STATUS[p.value] ?? human(p.value) },
    {
      field: 'decision', headerName: 'JUNCO says', width: 145,
      cellRenderer: (p: { value: CaseRow['decision'] }) => p.value
        ? <span className={`jd-badge jd-b-${p.value}`}>{DECISION_LABEL[p.value]}</span>
        : <span className="jd-muted">Not reviewed</span>,
    },
    {
      field: 'pending_holds', headerName: 'Approvals', width: 115,
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
          theme={theme}
          rowData={data ?? []}
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
