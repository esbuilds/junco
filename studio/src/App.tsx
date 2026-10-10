import { useMemo, useState } from 'react';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { studioTheme } from 'ag-studio';
import { widgets } from './widgets/definitions';
import { StartHere } from './widgets/StartHere';
import { ReplayDrawer } from './widgets/ReplayDrawer';
import { FIELDS, insightsPage, toRows } from './insights';
import { usePoll } from './store';
import { aiSetup, aiToolDisplayAll } from './studioAi';
import type { CaseRow } from './api';
import './styles.css';

// Pre-built desk layout: summary stats, Dispute this store, then holds and activity, then at-risk, outcomes and queue on the left, case on the right.
const layout = {
  pages: [{
    id: 'desk',
    layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
    widgets: {
      stats: { id: 'stats', type: 'junco-stats', dataMapping: {} },
      store: { id: 'store', type: 'junco-store-dispute', dataMapping: {} },
      holds: { id: 'holds', type: 'junco-holds', dataMapping: {} },
      activity: { id: 'activity', type: 'junco-activity', dataMapping: {} },
      risk: { id: 'risk', type: 'junco-at-risk', dataMapping: {} },
      ledger: { id: 'ledger', type: 'junco-ledger', dataMapping: {} },
      queue: { id: 'queue', type: 'junco-queue', dataMapping: {} },
      case: { id: 'case', type: 'junco-case', dataMapping: {} },
    },
    widgetLayout: {
      stats: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 4 },
      store: { xTrack: 0, yTrack: 4, xSpan: 12, ySpan: 8 },
      holds: { xTrack: 0, yTrack: 12, xSpan: 6, ySpan: 7 },
      activity: { xTrack: 6, yTrack: 12, xSpan: 6, ySpan: 7 },
      risk: { xTrack: 0, yTrack: 19, xSpan: 4, ySpan: 7 },
      ledger: { xTrack: 4, yTrack: 19, xSpan: 3, ySpan: 7 },
      queue: { xTrack: 0, yTrack: 26, xSpan: 7, ySpan: 15 },
      case: { xTrack: 7, yTrack: 19, xSpan: 5, ySpan: 22 },
    },
  }, insightsPage, {
    // Scenario mode: synthetic cases through the real recommender, no PayPal calls.
    id: 'try',
    layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
    widgets: { try: { id: 'try', type: 'junco-try', dataMapping: {} } },
    widgetLayout: { try: { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 34 } },
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
    widgetLayout: { policy: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 38 } },
  }],
  selectedPageId: 'desk',
};

// JUNCO theme for Studio's native widgets (Insights charts and filters): the desk palette and Inter, light or dark.
const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
const C = dark
  ? { bg: '#141413', surface: '#1d1d1b', ink: '#ecebe6', muted: '#a09f98', line: '#34332f', accent: '#5fb497', fills: ['#5fb497', '#8fb2ee', '#e5a54a', '#ef8a80', '#7fcf9b', '#c9a7e8', '#a09f98', '#f2d27a'] }
  : { bg: '#f6f5f1', surface: '#ffffff', ink: '#1d1d1b', muted: '#6b6a64', line: '#e3e0d8', accent: '#1f5c4a', fills: ['#1f5c4a', '#2b4f8a', '#a15c07', '#a8322a', '#5f9e7d', '#7a5aa6', '#6b6a64', '#c7922f'] };
const theme = studioTheme.withParams({
  fontFamily: 'Inter, system-ui, sans-serif', chartFontFamily: 'Inter, system-ui, sans-serif',
  backgroundColor: C.surface, textColor: C.ink, borderColor: C.line,
  studioCanvasBackgroundColor: C.bg, studioWidgetBackgroundColor: C.surface,
  studioWidgetTitleTextColor: C.ink, studioWidgetSubtitleTextColor: C.muted, studioWidgetCaptionTextColor: C.muted,
  studioToggleButtonActiveBackgroundColor: C.accent, studioToggleButtonActiveBorderColor: C.accent, studioToggleButtonActiveColor: C.accent,
  chartTextColor: C.ink, chartSubtleTextColor: C.muted, chartGridLineColor: C.line, chartAxisLineColor: C.muted,
  ...Object.fromEntries(C.fills.map((c, i) => [`chartPaletteFills${i + 1}Color`, c])),
} as any);

// Studio shows no page tabs in view mode, so the desk has its own slim header to switch pages.
// STUDIO_AI=1 at build time: the Desk opens with AG Studio's AI assistant (an edit-mode panel). Off: the desk as before.
const ai = __STUDIO_AI__ ? aiSetup() : undefined;

const PAGES = [['desk', 'Desk'], ['orders', 'Orders'], ['insights', 'Insights'], ['policy', 'Policy'], ['try', 'Try it']] as const;

export function App() {
  const [page, setPage] = useState<string>('desk');
  // Live disputes for the Insights page; only the rows change after first render (see insights.ts).
  const cases = usePoll<CaseRow[]>('/api/cases', 15000);
  const data = useMemo(() => ({ sources: [{ id: 'disputes', name: 'Disputes', description: "The merchant's PayPal disputes, one row each. A dispute the merchant is about to lose (this week or otherwise) is one that is still open and that JUNCO says to Accept; Days left says how soon. This is the same rule as the desk's At risk this week panel.", data: toRows(cases.data ?? []), fields: FIELDS }] }), [cases.data]);
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
      <ReplayDrawer />
      <div className="jd-host">
        {/* Studio mounts once the first cases arrive: native widgets (filters, grid) build their first query on mount. */}
        {!cases.data && !cases.error ? <div className="jd-empty">Loading disputes from PayPal...</div> : <AgStudio
          key={page}
          // Desk widgets read the desk API themselves; the Insights page runs on this Studio data source.
          data={data as any}
          widgets={widgets}
          initialState={{ ...layout, selectedPageId: page } as any}
          mode={ai && page === 'desk' ? 'edit' : 'view'}
          theme={theme}
          // The desk is a fixed layout for the judges: no filter panel in view mode.
          panels={{ view: { left: [], right: [] }, edit: { left: [], right: ['ai'] } }}
          {...(ai ? { ai, aiToolDisplay: aiToolDisplayAll } : {})}
        />}
      </div>
    </AgStudioProvider>
  );
}
