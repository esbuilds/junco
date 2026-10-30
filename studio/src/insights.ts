// Insights: the disputes as an AG Studio data source, so Studio's own charts and filters cross-filter them.
// ponytail: Studio's native grid widget rendered no columns next to our community-module grid; the Desk queue covers the table.
// Studio ignores sources added after first render, so the source and its fields are declared up front and only
// the rows change as the desk polls.
import { daysLeft, DECISION_LABEL, human, REASONS, STATUS, type CaseRow } from './api';

const KEPT = new Set(['RESOLVED_SELLER_FAVOUR', 'RESOLVED_WITH_PAYOUT', 'CANCELED_BY_BUYER', 'DENIED']); // same rule as the Simulated lifecycle outcomes widget

export const FIELDS = [
  { id: 'dispute', name: 'Dispute', format: 'textFormat' },
  { id: 'reason', name: 'Reason', format: 'textFormat' },
  { id: 'status', name: 'Status', format: 'textFormat', description: 'Where the dispute stands. "Resolved" means closed; anything else is still open.' },
  { id: 'junco_says', name: 'JUNCO says', format: 'textFormat', description: 'What JUNCO recommends. "Accept" means JUNCO expects the merchant to lose this dispute.' },
  { id: 'deadline', name: 'Deadline', format: 'textFormat', description: 'When the merchant must respond: Due this week (7 days or less), Due later, No deadline yet, or Resolved.' },
  { id: 'days_left', name: 'Days left', format: 'integerFormat', description: 'Days until the response deadline; empty when PayPal has set none. 7 or less means due this week.' },
  { id: 'amount', name: 'Amount', format: 'currencyFormat' },
  { id: 'kept', name: 'Not refunded', format: 'currencyFormat' },
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
      junco_says: r.decision ? DECISION_LABEL[r.decision] : 'Not reviewed', deadline: bucket(r), days_left: resolved ? null : daysLeft(r.due),
      amount: r.amount, kept: resolved ? r.amount - refunded : 0, refunded,
    };
  });
}

const title = (text: string) => ({ title: { text, enabled: true } });

// The Books: every AI purchase as a second source, so Studio's filters narrow its table the way they narrow Matching. A widget
// picks fields by name across every source, so these ids stay apart from FIELDS' (check-ui pins it).
export const BOOK_FIELDS = [
  { id: 'purchase', name: 'Purchase', format: 'textFormat' },
  { id: 'title', name: 'Title', format: 'textFormat' },
  { id: 'at', name: 'Last activity', format: 'textFormat' },
  { id: 'paid', name: 'Paid', format: 'currencyFormat' },
  { id: 'paypal_status', name: 'PayPal status', format: 'textFormat' },
  { id: 'refunds', name: 'Refunds', format: 'textFormat' },
  { id: 'holds', name: 'Desk holds', format: 'integerFormat' },
  { id: 'fingerprint', name: 'Fingerprint', format: 'textFormat' },
  { id: 'reconciliation', name: 'Reconciliation', format: 'textFormat', description: 'Differ: what the desk recorded and what PayPal shows do not line up. A dispute hold is not a difference. Unread: PayPal did not answer.' },
  { id: 'line', name: 'Why', format: 'textFormat' },
  { id: 'replay', name: 'Policy replay', format: 'textFormat', description: "WHAT-IF: each recorded money move re-run under today's policy. It never reaches PayPal." },
  { id: 'replay_detail', name: 'Replay detail', format: 'textFormat' },
];

export const booksPage = {
  id: 'books',
  layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
  widgets: {
    bookRecon: { id: 'bookRecon', type: 'button-filter', format: title('Reconciliation'), dataMapping: { value: [{ id: 'books.reconciliation' }] } },
    bookStatus: { id: 'bookStatus', type: 'button-filter', format: title('PayPal status'), dataMapping: { value: [{ id: 'books.paypal_status' }] } },
    bookPrint: { id: 'bookPrint', type: 'button-filter', format: title('Fingerprint'), dataMapping: { value: [{ id: 'books.fingerprint' }] } },
    bookReplay: { id: 'bookReplay', type: 'button-filter', format: title('Policy replay'), dataMapping: { value: [{ id: 'books.replay' }] } },
    books: { id: 'books', type: 'junco-books', dataMapping: {} },
  },
  widgetLayout: {
    bookRecon: { xTrack: 0, yTrack: 0, xSpan: 2, ySpan: 8 },
    bookStatus: { xTrack: 2, yTrack: 0, xSpan: 4, ySpan: 8 }, // PayPal's statuses are the longest labels
    bookPrint: { xTrack: 6, yTrack: 0, xSpan: 3, ySpan: 8 },
    bookReplay: { xTrack: 9, yTrack: 0, xSpan: 3, ySpan: 8 },
    books: { xTrack: 0, yTrack: 8, xSpan: 12, ySpan: 36 },
  },
};

export const insightsPage = {
  id: 'insights',
  layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
  widgets: {
    byReason: { id: 'byReason', type: 'button-filter', format: title('Reason'), dataMapping: { value: [{ id: 'disputes.reason' }] } },
    bySays: { id: 'bySays', type: 'button-filter', format: title('JUNCO says'), dataMapping: { value: [{ id: 'disputes.junco_says' }] } },
    byStatus: { id: 'byStatus', type: 'donut-chart', format: title('Money in dispute by status'), dataMapping: { categoryKey: [{ id: 'disputes.status' }], valueKey: [{ id: 'disputes.amount', aggregation: 'sum' }] } },
    byDeadline: { id: 'byDeadline', type: 'column-chart-grouped', format: title('Amount by deadline'), dataMapping: { categoryKey: [{ id: 'disputes.deadline' }], valueKey: [{ id: 'disputes.amount', aggregation: 'sum' }] } },
    ledger: { id: 'ledger', type: 'junco-ledger', dataMapping: {} }, // moved off the Desk (v3.14)
    matching: { id: 'matching', type: 'junco-matching', dataMapping: {} }, // the rows behind the charts, filtered by Studio (v3.14)
    // coldjudge F9: was simulated outcomes by reason (one bar from two sandbox verdicts); now money by JUNCO's call.
    outcomes: { id: 'outcomes', type: 'bar-chart-grouped', format: title('Amount by what JUNCO says'), dataMapping: { categoryKey: [{ id: 'disputes.junco_says' }], valueKey: [{ id: 'disputes.amount', aggregation: 'sum' }] } },
  },
  widgetLayout: {
    byReason: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 6 },
    bySays: { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 6 },
    byStatus: { xTrack: 0, yTrack: 6, xSpan: 4, ySpan: 18 },
    byDeadline: { xTrack: 4, yTrack: 6, xSpan: 4, ySpan: 18 },
    outcomes: { xTrack: 8, yTrack: 6, xSpan: 4, ySpan: 18 },
    matching: { xTrack: 0, yTrack: 24, xSpan: 8, ySpan: 14 },
    ledger: { xTrack: 8, yTrack: 24, xSpan: 4, ySpan: 14 },
  },
};
