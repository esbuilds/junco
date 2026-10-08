import { daysLeft, money, type CaseRow, type Hold } from '../api';
import { usePoll } from '../store';

// Header stats, same four numbers as the reference desk (public/index.html).
export function StatsWidget() {
  const cases = usePoll<CaseRow[]>('/api/cases', 10000);
  const holds = usePoll<Hold[]>('/api/holds', 5000);

  const rows = cases.data ?? [];
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const cur = rows[0]?.currency ?? 'USD';
  const dues = rows.map((r) => daysLeft(r.due)).filter((d): d is number => d !== null).sort((a, b) => a - b);
  const next = !cases.data ? '-'
    : !dues.length ? 'None'
    : dues[0] <= 0 ? 'Today'
    : `${dues[0]} day${dues[0] === 1 ? '' : 's'}`;

  const tiles: [string, string][] = [
    ['Open cases', cases.data ? String(rows.length) : '-'],
    ['Money in dispute', cases.data ? money(total, cur) : '-'],
    ['Next deadline', next],
    ['Waiting for you', holds.data ? String(holds.data.length) : '-'],
  ];

  return (
    <div className="jd-stats" aria-label="Summary">
      {tiles.map(([label, value]) => (
        <div key={label} className="jd-stat">
          <div className="jd-muted">{label}</div>
          <div className="jd-stat-v">{value}</div>
        </div>
      ))}
    </div>
  );
}
