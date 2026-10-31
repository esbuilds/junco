import { money, type CaseRow, type Hold } from '../api';
import { usePoll } from '../store';
import { splitHolds } from '../ui';

type GateCounts = { counts: { proposed: number; held: number; past_limit: number } };

// The Desk's KPI strip: one bordered strip, four cells. Only "Waiting for your OK" carries the attention colour.
// Numbers come from the same endpoints as the widgets below (holds, the Gate record, the cases).
export function StatsWidget() {
  const cases = usePoll<CaseRow[]>('/api/cases', 10000);
  const holds = usePoll<Hold[]>('/api/holds', 5000);
  const gate = usePoll<GateCounts>('/api/gate-record', 15000);

  const open = (cases.data ?? []).filter((r) => r.status !== 'RESOLVED'); // resolved cases live in the Outcomes widget
  const total = open.reduce((s, r) => s + r.amount, 0);
  const cur = open[0]?.currency ?? 'USD';
  const g = gate.data?.counts;
  const h = holds.data ? splitHolds(holds.data) : null;

  const cells: { label: string; value: string; unit?: string; sub: string; attn?: boolean }[] = [
    // Money moves only, the same count as the Gate record's "waiting"; other held actions are named in the sub-line.
    { label: 'Waiting for your OK', value: h ? String(h.money.length) : '-', sub: h ? `money move${h.money.length === 1 ? '' : 's'}${h.pending.length > h.money.length ? ` · ${h.pending.length - h.money.length} other` : ''}` : '', attn: true },
    { label: 'Money moves proposed', value: g ? String(g.proposed) : '-', sub: 'by any agent' },
    // All time, every source. past_limit: concessions an agent got past the owner's limit (Break the mandate's count).
    { label: 'Held for you', value: g ? String(g.held) : '-', sub: g ? `${g.past_limit} past your limit` : '' },
    { label: 'Open disputes', value: cases.data ? money(total, cur).replace(/[^\d.,]/g, '') : '-', unit: cases.data ? cur : undefined, sub: cases.data ? `${open.length} case${open.length === 1 ? '' : 's'}` : '' },
  ];

  return (
    <div className="jd-kpis" aria-label="Summary">
      {cells.map((c) => (
        <div key={c.label} className="jd-kpi">
          <div className={c.attn ? 'jd-kpi-l jd-attn' : 'jd-kpi-l'}>{c.attn && <i className="jd-dot jd-dot-attn" aria-hidden="true" />}{c.label}</div>
          <div className="jd-kpi-v">{c.value}{c.unit && <small> {c.unit}</small>}</div>
          <div className="jd-kpi-sub">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}
