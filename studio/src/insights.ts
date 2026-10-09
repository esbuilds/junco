// Insights: the disputes as an AG Studio data source, so Studio's own charts and filters cross-filter them.
// ponytail: Studio's native grid widget rendered no columns next to our community-module grid; the Desk queue covers the table.
// Studio ignores sources added after first render, so the source and its fields are declared up front and only
// the rows change as the desk polls.
import { daysLeft, DECISION_LABEL, human, REASONS, STATUS, type CaseRow } from './api';

const KEPT = new Set(['RESOLVED_SELLER_FAVOUR', 'RESOLVED_WITH_PAYOUT', 'CANCELED_BY_BUYER', 'DENIED']); // same rule as the Outcomes widget

export const FIELDS = [
  { id: 'dispute', name: 'Dispute', format: 'textFormat' },
  { id: 'reason', name: 'Reason', format: 'textFormat' },
  { id: 'status', name: 'Status', format: 'textFormat' },
  { id: 'junco_says', name: 'JUNCO says', format: 'textFormat' },
  { id: 'deadline', name: 'Deadline', format: 'textFormat' },
  { id: 'amount', name: 'Amount', format: 'currencyFormat' },
  { id: 'kept', name: 'Kept', format: 'currencyFormat' },
  { id: 'refunded', name: 'Refunded', format: 'currencyFormat' },
];

const bucket = (r: CaseRow) => {
  if (r.status === 'RESOLVED') return 'Resolved';
  const d = daysLeft(r.due);
  return d === null ? 'No deadline yet' : d <= 7 ? 'Due this week' : 'Due later';
};

export function toRows(cases: CaseRow[]) {
  return cases.map((r) => {
    const resolved = r.status === 'RESOLVED';
    const refunded = !resolved ? 0 : r.outcome && KEPT.has(r.outcome) ? 0 : r.refunded ?? r.amount;
    return {
      dispute: r.id, reason: REASONS[r.reason] ?? human(r.reason), status: STATUS[r.status] ?? human(r.status),
      junco_says: r.decision ? DECISION_LABEL[r.decision] : 'Not reviewed', deadline: bucket(r),
      amount: r.amount, kept: resolved ? r.amount - refunded : 0, refunded,
    };
  });
}

const title = (text: string) => ({ title: { text, enabled: true } });

export const insightsPage = {
  id: 'insights',
  layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
  widgets: {
    byReason: { id: 'byReason', type: 'button-filter', format: title('Reason'), dataMapping: { value: [{ id: 'disputes.reason' }] } },
    bySays: { id: 'bySays', type: 'button-filter', format: title('JUNCO says'), dataMapping: { value: [{ id: 'disputes.junco_says' }] } },
    byStatus: { id: 'byStatus', type: 'donut-chart', format: title('Money in dispute by status'), dataMapping: { categoryKey: [{ id: 'disputes.status' }], valueKey: [{ id: 'disputes.amount', aggregation: 'sum' }] } },
    byDeadline: { id: 'byDeadline', type: 'column-chart-grouped', format: title('Amount by deadline'), dataMapping: { categoryKey: [{ id: 'disputes.deadline' }], valueKey: [{ id: 'disputes.amount', aggregation: 'sum' }] } },
    outcomes: { id: 'outcomes', type: 'bar-chart-stacked', format: title('Kept vs refunded by reason'), dataMapping: { categoryKey: [{ id: 'disputes.reason' }], valueKey: [{ id: 'disputes.kept', aggregation: 'sum' }, { id: 'disputes.refunded', aggregation: 'sum' }] } },
  },
  widgetLayout: {
    byReason: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 6 },
    bySays: { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 6 },
    byStatus: { xTrack: 0, yTrack: 6, xSpan: 4, ySpan: 18 },
    byDeadline: { xTrack: 4, yTrack: 6, xSpan: 4, ySpan: 18 },
    outcomes: { xTrack: 8, yTrack: 6, xSpan: 4, ySpan: 18 },
  },
};
