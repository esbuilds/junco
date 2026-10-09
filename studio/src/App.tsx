import { useState } from 'react';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { widgets } from './widgets/definitions';
import { StartHere } from './widgets/StartHere';
import './styles.css';

// Pre-built desk layout: summary stats, then holds and activity, then at-risk, outcomes and queue on the left, case on the right.
const layout = {
  pages: [{
    id: 'desk',
    layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
    widgets: {
      stats: { id: 'stats', type: 'junco-stats', dataMapping: {} },
      holds: { id: 'holds', type: 'junco-holds', dataMapping: {} },
      activity: { id: 'activity', type: 'junco-activity', dataMapping: {} },
      risk: { id: 'risk', type: 'junco-at-risk', dataMapping: {} },
      ledger: { id: 'ledger', type: 'junco-ledger', dataMapping: {} },
      queue: { id: 'queue', type: 'junco-queue', dataMapping: {} },
      case: { id: 'case', type: 'junco-case', dataMapping: {} },
    },
    widgetLayout: {
      stats: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 4 },
      holds: { xTrack: 0, yTrack: 4, xSpan: 6, ySpan: 7 },
      activity: { xTrack: 6, yTrack: 4, xSpan: 6, ySpan: 7 },
      risk: { xTrack: 0, yTrack: 11, xSpan: 4, ySpan: 7 },
      ledger: { xTrack: 4, yTrack: 11, xSpan: 3, ySpan: 7 },
      queue: { xTrack: 0, yTrack: 18, xSpan: 7, ySpan: 15 },
      case: { xTrack: 7, yTrack: 11, xSpan: 5, ySpan: 22 },
    },
  }, {
    // Prevention: paid orders watched until they have tracking, before any dispute exists.
    id: 'orders',
    layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
    widgets: { orders: { id: 'orders', type: 'junco-orders', dataMapping: {} } },
    widgetLayout: { orders: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 30 } },
  }, {
    // Second page: the owner's policy, so the gate's limits are a setting on screen instead of a file.
    id: 'policy',
    layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
    widgets: { policy: { id: 'policy', type: 'junco-policy', dataMapping: {} } },
    widgetLayout: { policy: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 28 } },
  }],
  selectedPageId: 'desk',
};

// Studio shows no page tabs in view mode, so the desk has its own slim header to switch pages.
const PAGES = [['desk', 'Desk'], ['orders', 'Orders'], ['policy', 'Policy']] as const;

export function App() {
  const [page, setPage] = useState<string>('desk');
  return (
    <AgStudioProvider licenseKey={__AG_STUDIO_KEY__}>
      <header className="jd-topbar">
        <strong>JUNCO</strong><span className="jd-muted">Dispute desk</span><span className="jd-tag">PayPal sandbox</span>
        <nav aria-label="Pages">
          <StartHere go={setPage} />
          {PAGES.map(([id, label]) => (
            <button key={id} type="button" className="jd-tab" aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}>{label}</button>
          ))}
        </nav>
      </header>
      <div className="jd-host">
        <AgStudio
          key={page}
          // The desk has no Studio data sources yet: each widget reads the desk API itself.
          data={{ sources: [] }}
          widgets={widgets}
          initialState={{ ...layout, selectedPageId: page } as any}
          mode="view"
          // The desk is a fixed layout for the judges: no filter panel in view mode.
          panels={{ view: { left: [], right: [] } }}
        />
      </div>
    </AgStudioProvider>
  );
}
