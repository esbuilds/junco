import { money, REASONS, human, type CaseRow } from '../api';
import { selectCase, usePoll } from '../store';
import { Panel } from './Panel';

// Outcome ledger: resolved cases with what the merchant kept vs refunded, from PayPal's dispute_outcome.
// Sandbox numbers only. The fee note cites PayPal's own pages (standard US dispute fee, not charged before a claim).
const FEE_PAGE = 'https://www.paypal.com/us/webapps/mpp/merchant-fees#statement-19';
// Merchant keeps the money on these. ponytail: RESOLVED_WITH_PAYOUT read as PayPal paying the buyer under seller protection; confirm on the first real payout outcome.
const KEPT = new Set(['RESOLVED_SELLER_FAVOUR', 'RESOLVED_WITH_PAYOUT', 'CANCELED_BY_BUYER', 'DENIED']);
const OUTCOME: Record<string, string> = {
  RESOLVED_SELLER_FAVOUR: 'Won', RESOLVED_BUYER_FAVOUR: 'Lost', RESOLVED_WITH_PAYOUT: 'Paid out by PayPal',
  CANCELED_BY_BUYER: 'Buyer cancelled', ACCEPTED: 'Accepted', DENIED: 'Denied',
};

const refundedOf = (r: CaseRow) => (r.outcome && KEPT.has(r.outcome) ? 0 : r.refunded ?? r.amount);

export function LedgerWidget() {
  const { data, error } = usePoll<CaseRow[]>('/api/cases', 10000);
  const done = (data ?? []).filter((r) => r.status === 'RESOLVED');
  const total = done.reduce((s, r) => s + r.amount, 0);
  const kept = done.reduce((s, r) => s + r.amount - refundedOf(r), 0);
  const cur = done[0]?.currency ?? 'USD';

  return (
    <Panel title="Outcomes" subtitle={!data ? 'Loading' : done.length ? `Kept ${money(kept, cur)} of ${money(total, cur)} disputed` : 'No resolved disputes yet'}>
      {error && <div className="jd-result jd-err">{error}</div>}
      <ul className="jd-risk">
        {done.map((r) => {
          const refunded = refundedOf(r);
          const won = refunded === 0;
          return (
            <li key={r.id}>
              <button type="button" className="jd-risk-row" onClick={() => selectCase(r.id)}>
                <span className="jd-risk-main"><strong>{REASONS[r.reason] ?? human(r.reason)}</strong> <span className="jd-muted">{r.id}</span></span>
                <span className="jd-risk-amt">{won ? `Kept ${money(r.amount, r.currency)}` : `Refunded ${money(refunded, r.currency)}`}</span>
                <span className="jd-risk-why">
                  <span className={`jd-badge ${won ? 'jd-b-contest' : 'jd-b-accept'}`}>{OUTCOME[r.outcome ?? ''] ?? human(r.outcome ?? 'resolved')}</span>
                  {r.stage === 'INQUIRY' && <a className="jd-badge jd-b-wait" href={FEE_PAGE} target="_blank" rel="noreferrer">Settled before a claim: no $15 dispute fee</a>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
