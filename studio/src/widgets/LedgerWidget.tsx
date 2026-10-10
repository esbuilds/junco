import { money, REASONS, human, type CaseRow } from '../api';
import { selectCase, usePoll } from '../store';
import { Panel } from './Panel';

// Simulated lifecycle outcomes: resolved sandbox cases and what was refunded, from PayPal's dispute_outcome. In the sandbox
// we pick the verdict through the adjudicate endpoint, so labels stay neutral and nothing here is a win rate or a saving.
// Merchant keeps the money on these. ponytail: RESOLVED_WITH_PAYOUT read as PayPal paying the buyer under seller protection; confirm on the first real payout outcome.
const KEPT = new Set(['RESOLVED_SELLER_FAVOUR', 'RESOLVED_WITH_PAYOUT', 'CANCELED_BY_BUYER', 'DENIED']);
const OUTCOME: Record<string, string> = {
  RESOLVED_SELLER_FAVOUR: 'Seller favour', RESOLVED_BUYER_FAVOUR: 'Buyer favour', RESOLVED_WITH_PAYOUT: 'Paid out by PayPal',
  CANCELED_BY_BUYER: 'Buyer cancelled', ACCEPTED: 'Accepted', DENIED: 'Denied',
};

const refundedOf = (r: CaseRow) => (r.outcome && KEPT.has(r.outcome) ? 0 : r.refunded ?? r.amount);

export function LedgerWidget() {
  const { data, error } = usePoll<CaseRow[]>('/api/cases', 10000);
  const done = (data ?? []).filter((r) => r.status === 'RESOLVED');

  return (
    <Panel title="Simulated lifecycle outcomes" subtitle={!data ? 'Loading' : done.length ? `${done.length} resolved in the sandbox; verdicts chosen by us` : 'No resolved disputes yet'}>
      {error && <div className="jd-result jd-err">{error}</div>}
      <ul className="jd-risk">
        {done.map((r) => {
          const refunded = refundedOf(r);
          return (
            <li key={r.id}>
              <button type="button" className="jd-risk-row" onClick={() => selectCase(r.id)}>
                <span className="jd-risk-main"><strong>{REASONS[r.reason] ?? human(r.reason)}</strong> <span className="jd-muted">{r.id}</span></span>
                <span className="jd-risk-amt">{refunded ? `Refunded ${money(refunded, r.currency)}` : 'No refund'}</span>
                <span className="jd-risk-why">
                  <span className="jd-badge jd-b-wait">{OUTCOME[r.outcome ?? ''] ?? human(r.outcome ?? 'resolved')}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
