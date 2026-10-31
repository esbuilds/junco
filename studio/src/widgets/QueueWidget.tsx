import { useEffect, useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, type ColDef, type GridApi } from 'ag-grid-community';
import { gridTheme } from '../theme';
import { dueText, human, money, REASONS, STATUS, DECISION_LABEL, type CaseRow } from '../api';
import { selectCase, useSelectedCase, usePoll } from '../store';
import { Panel } from './Panel';

ModuleRegistry.registerModules([AllCommunityModule]);

// Short labels so the queue fits at 1280 wide; the full reason is in the tooltip and on the case.
const SHORT_REASON: Record<string, string> = { MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Not received', MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Not as described' };

export function QueueWidget() {
  const all = usePoll<CaseRow[]>('/api/cases', 10000);
  const { error } = all;
  const data = all.data?.filter((r) => r.status !== 'RESOLVED') ?? null; // resolved cases live in the Outcomes widget
  const selected = useSelectedCase();
  const gridApi = useRef<GridApi<CaseRow> | null>(null);

  const columns = useMemo<ColDef<CaseRow>[]>(() => [
    { field: 'id', headerName: 'Case', width: 120, valueFormatter: (p) => String(p.value).replace(/^PP-R-/, ''), cellClass: 'jd-mono-cell' },
    { field: 'reason', headerName: 'Reason', flex: 1, minWidth: 118, valueFormatter: (p) => SHORT_REASON[p.value] ?? REASONS[p.value] ?? human(p.value), tooltipValueGetter: (p) => REASONS[p.data?.reason ?? ''] },
    // Amounts: tabular, right-aligned, currency written out ("38.00 USD").
    { field: 'amount', headerName: 'Amount', width: 108, type: 'rightAligned', cellClass: 'jd-num', valueFormatter: (p) => `${money(p.value, p.data?.currency).replace(/[^\d.,]/g, '')} ${p.data?.currency ?? ''}` },
    {
      // Status and deadline in one column: "Your turn · 10 days". Sorting follows the deadline.
      field: 'status', headerName: 'Status', flex: 1.3, minWidth: 140, sort: 'asc', // soonest deadline on page one
      comparator: (_a: string, _b: string, na: any, nb: any) => (na.data?.due ? Date.parse(na.data.due) : Infinity) - (nb.data?.due ? Date.parse(nb.data.due) : Infinity),
      cellRenderer: (p: { data?: CaseRow }) => {
        // Copper only when it's the merchant's move; every other status is gray.
        const yours = p.data?.status === 'WAITING_FOR_SELLER_RESPONSE';
        return <span className={yours ? 'jd-st jd-st-attn' : 'jd-st'}><i className={yours ? 'jd-dot jd-dot-attn' : 'jd-dot'} aria-hidden="true" />{STATUS[p.data?.status ?? ''] ?? human(p.data?.status)}{p.data?.due && <> · {dueText(p.data.due)}</>}</span>;
      },
    },
    {
      field: 'decision', headerName: 'JUNCO says', width: 124,
      cellRenderer: (p: { value: CaseRow['decision'] }) => p.value
        ? <span>{DECISION_LABEL[p.value]}</span>
        : <span className="jd-muted">Not reviewed</span>,
    },
    {
      field: 'pending_holds', headerName: 'Approvals', width: 100,
      cellRenderer: (p: { value: number }) => p.value ? <span className="jd-flag">{p.value} waiting</span> : null,
    },
  ], []);

  // Re-style the selected row when the selection changes elsewhere on the dashboard.
  useEffect(() => { gridApi.current?.redrawRows(); }, [selected]);

  return (
    <Panel title="Dispute queue" subtitle={data ? undefined : 'Loading'} live>
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
          // The case opens under the queue, so a click brings it into view.
          onRowClicked={(e) => { if (e.data) { selectCase(e.data.id); setTimeout(() => document.getElementById('jd-case')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100); } }}
          domLayout="autoHeight"
          pagination
          paginationPageSize={6}
          paginationPageSizeSelector={false}
          overlayNoRowsTemplate='<span class="jd-muted">No disputes in this sandbox account.</span>'
        />
      </div>
    </Panel>
  );
}
