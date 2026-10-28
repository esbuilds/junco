import { useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { api, money } from '../api';
import { usePoll } from '../store';
import { Panel } from './Panel';
import { gridTheme } from '../theme';

// Shipment watch: every captured payment, watched until it has tracking on PayPal. Prevention, before any dispute.
type Watched = {
  capture_id: string; order_id: string; amount: number; currency: string; captured_at: string; item: string | null;
  ship_to: string | null; trackers: { number: string; status: string }[]; flags: { code: string; text: string }[];
  status: 'protected' | 'watching' | 'at_risk'; ship_by: string; reason: string | null;
};
const STATUS_LABEL = { protected: 'Protected', watching: 'Watching', at_risk: 'At risk' } as const;
const STATUS_CLASS = { protected: 'jd-b-contest', watching: 'jd-b-wait', at_risk: 'jd-b-held' } as const; // at risk: the owner must add tracking

function shipByText(o: Watched) {
  if (o.status === 'protected') return 'Shipped';
  const hrs = Math.round((Date.parse(o.ship_by) - Date.now()) / 3_600_000);
  if (hrs < 0) return `${Math.ceil(-hrs / 24)}d overdue`;
  return hrs < 24 ? `${hrs}h left` : `${Math.floor(hrs / 24)}d ${hrs % 24}h left`;
}

export function OrdersWidget() {
  const { data, error, reload } = usePoll<{ seller_protection_page: string; items: Watched[] }>('/api/orders', 10000);
  const [pick, setPick] = useState<string | null>(null);
  const [carrier, setCarrier] = useState('USPS');
  const [number, setNumber] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const items = data?.items ?? [];
  const sel = items.find((o) => o.capture_id === pick) ?? null;

  const columns = useMemo<ColDef<Watched>[]>(() => [
    { headerName: 'Order', field: 'order_id', flex: 1.1, minWidth: 170, cellClass: 'jd-mono-cell' },
    { headerName: 'Item', field: 'item', flex: 1.4, minWidth: 170, tooltipField: 'item', valueFormatter: (p) => p.value ?? '' },
    { headerName: 'Amount', field: 'amount', width: 108, type: 'rightAligned', cellClass: 'jd-num', valueFormatter: (p) => `${money(p.value, p.data?.currency).replace(/[^\d.,]/g, '')} ${p.data?.currency ?? ''}` },
    { headerName: 'Paid', field: 'captured_at', width: 120, valueFormatter: (p) => new Date(p.value).toLocaleDateString([], { month: 'short', day: 'numeric' }) },
    { headerName: 'Ship by', field: 'ship_by', width: 120, valueGetter: (p) => p.data && shipByText(p.data) },
    { headerName: 'Status', field: 'status', width: 120, cellRenderer: (p: any) => <span className={`jd-badge ${STATUS_CLASS[p.value as Watched['status']]}`}>{STATUS_LABEL[p.value as Watched['status']]}</span> },
    { headerName: 'What to do', field: 'reason', flex: 2.4, minWidth: 220, wrapText: true, autoHeight: true, cellStyle: { lineHeight: '1.4', paddingTop: '8px', paddingBottom: '8px' }, valueGetter: (p) => p.data?.reason ?? (p.data?.status === 'protected' ? `Tracking ${p.data.trackers.at(-1)?.number} is on PayPal` : 'Add tracking once it ships'), tooltipField: 'reason' },
  ], []);

  const add = async () => {
    if (!sel) return;
    setBusy(true); setMsg(null);
    try {
      await api(`/api/orders/${sel.capture_id}/track`, { method: 'POST', json: { carrier, tracking_number: number } });
      setMsg({ ok: true, text: `Tracking added to PayPal for ${sel.order_id}.` }); setNumber(''); reload();
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const atRisk = items.filter((o) => o.status === 'at_risk').length;
  return (
    <Panel title="Shipment watch" subtitle={!data ? 'Loading' : `${items.length} paid order${items.length === 1 ? '' : 's'} watched · ${atRisk} at risk`} live>
      {error && <div className="jd-result jd-err">{error}</div>}
      <p className="jd-muted" style={{ margin: '0 0 8px' }}>
        Every captured PayPal payment is watched until it has tracking. Seller Protection needs a verifiable tracking number and shipping to the address on the order (<a href={data?.seller_protection_page} target="_blank" rel="noreferrer">PayPal's Seller Protection terms</a>). Ship-by time is your policy.
      </p>
      <div className="jd-grid">
        <AgGridReact<Watched>
          theme={gridTheme} rowData={items} loading={!data && !error} columnDefs={columns} getRowId={(p) => p.data.capture_id}
          rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
          onRowClicked={(e) => { if (e.data) { setPick(e.data.capture_id); setMsg(null); } }}
          domLayout="autoHeight" overlayNoRowsTemplate='<span class="jd-muted">No captured payments yet. New ones appear here within seconds.</span>'
        />
      </div>
      {sel && sel.status !== 'protected' && (
        <div className="jd-handle jd-track" style={{ marginTop: 12 }}>
          <span><strong>{sel.order_id}</strong>{sel.ship_to ? ` · ship to ${sel.ship_to}` : ''}</span>
          <span className="jd-row" style={{ margin: 0 }}>
            <select value={carrier} onChange={(e) => setCarrier(e.target.value)} aria-label="Carrier">
              {['USPS', 'UPS', 'FEDEX', 'DHL'].map((c) => <option key={c} value={c}>{c === 'FEDEX' ? 'FedEx' : c}</option>)}
            </select>
            <input type="text" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Tracking number" aria-label="Tracking number" />
            <button type="button" className="jd-btn jd-primary" onClick={add} disabled={busy || !number.trim()}>{busy ? 'Adding...' : 'Add tracking to PayPal'}</button>
          </span>
        </div>
      )}
      {msg && <div className={`jd-result ${msg.ok ? 'jd-ok' : 'jd-err'}`}>{msg.text}</div>}
    </Panel>
  );
}
