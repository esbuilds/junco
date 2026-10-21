import { useEffect, useMemo, useState } from 'react';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { studioTheme } from 'ag-studio';
import { widgets } from './widgets/definitions';
import { StartHere, startSeen } from './widgets/StartHere';
import { CaseBanner } from './widgets/CaseBanner';
import { StatusLine } from './widgets/StatusLine';
import { ReplayDrawer } from './widgets/ReplayDrawer';
import { FIELDS, insightsPage, toRows } from './insights';
import { usePoll } from './store';
import { aiSetup, aiToolDisplayAll } from './studioAi';
import type { CaseRow } from './api';
import './styles.css';

// Pre-built desk layout (v3.14 first screen): Waiting for you and Agent activity, the Gate record, then queue and case;
// Dispute this store, summary stats and at-risk below (Start here's first step scrolls to Dispute this store).
// Simulated lifecycle outcomes moved to Insights (v3.14).
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
      gate: { id: 'gate', type: 'junco-gate-record', dataMapping: {} },
      queue: { id: 'queue', type: 'junco-queue', dataMapping: {} },
      case: { id: 'case', type: 'junco-case', dataMapping: {} },
    },
    widgetLayout: {
      holds: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 9 },
      activity: { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 9 },
      gate: { xTrack: 0, yTrack: 9, xSpan: 12, ySpan: 10 },
      queue: { xTrack: 0, yTrack: 19, xSpan: 7, ySpan: 22 },
      case: { xTrack: 7, yTrack: 19, xSpan: 5, ySpan: 22 },
      store: { xTrack: 0, yTrack: 41, xSpan: 12, ySpan: 14 },
      stats: { xTrack: 0, yTrack: 55, xSpan: 12, ySpan: 4 },
      risk: { xTrack: 0, yTrack: 59, xSpan: 7, ySpan: 7 },
    },
  }, insightsPage, {
    // Break the mandate: the visitor plays the buyer; the seller side is real on a never-shipped sandbox case.
    id: 'mandate',
    layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
    widgets: { mandate: { id: 'mandate', type: 'junco-challenge', dataMapping: {} } },
    widgetLayout: { mandate: { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 40 } },
  }, {
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

// v3.14 item 5: the owner can resize Desk panels from any edge (Studio's edit mode, on whenever the assistant is); this
// browser remembers the sizes. Only positions of the desk's own panels are kept, so a stale save can't add or drop a panel.
export const DESK_LAYOUT_KEY = 'jd-desk-layout';
function withSavedDesk(l: typeof layout) {
  let saved: Record<string, unknown> = {};
  try { saved = JSON.parse(localStorage.getItem(DESK_LAYOUT_KEY) ?? '{}') ?? {}; } catch { /* private mode or a bad save: defaults */ }
  return { ...l, pages: l.pages.map((p: any) => p.id !== 'desk' ? p : { ...p, widgetLayout: Object.fromEntries(Object.entries(p.widgetLayout).map(([k, v]) => [k, (saved[k] as object) ?? v])) }) };
}
function saveDesk(e: any) {
  const desk = (e?.state?.pages ?? []).find((p: any) => p.id === 'desk');
  if (!desk?.widgetLayout) return;
  try { localStorage.setItem(DESK_LAYOUT_KEY, JSON.stringify(desk.widgetLayout)); } catch { /* not saved; the layout still works */ }
}

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
  // v3.14 item 5: Studio's own widgets (Insights charts, filters) match the desk's panels: 12px corners, a 1px line,
  // 17px semibold titles, 13px subtitles and captions.
  studioWidgetBorderRadius: 12, studioWidgetBorder: { width: 1, color: C.line }, studioWidgetPadding: 16,
  studioWidgetTitleFontSize: 17, studioWidgetTitleFontWeight: 600, studioWidgetSubtitleFontSize: 13, studioWidgetCaptionFontSize: 13,
  accentColor: C.accent,
} as any);

// Studio shows no page tabs in view mode, so the desk has its own slim header to switch pages.
// STUDIO_AI=1 at build time: the Desk opens with AG Studio's AI assistant (an edit-mode panel). Off: the desk as before.
const ai = __STUDIO_AI__ ? aiSetup() : undefined;

const PAGES = [['desk', 'Desk'], ['orders', 'Orders'], ['insights', 'Insights'], ['policy', 'Policy'], ['mandate', 'Break the mandate'], ['try', 'Try it']] as const;

// The desk's runtime key (index.html, from its env) wins; the dev server's build-time one is the fallback.
const studioKey = (window as { JUNCO_STUDIO_KEY?: string }).JUNCO_STUDIO_KEY || __AG_STUDIO_KEY__;

export function App() {
  const [start, setStart] = useState(() => !startSeen());
  useEffect(() => { const on = (e: Event) => setPage((e as CustomEvent).detail); window.addEventListener('jd-go', on); return () => window.removeEventListener('jd-go', on); }, []);
  const [page, setPage] = useState<string>(() => new URLSearchParams(location.search).get('page') ?? 'desk'); // ?page= links (the counter's Gate record link)
  // Live disputes for the Insights page; only the rows change after first render (see insights.ts).
  const cases = usePoll<CaseRow[]>('/api/cases', 15000);
  // A new data object restarts Studio's chart queries; the 15 s poll returns a new array every time, so only real
  // changes to the rows count (charts took about 30 s to settle when every poll counted).
  const rowsKey = JSON.stringify(cases.data ?? []);
  const data = useMemo(() => ({ sources: [{ id: 'disputes', name: 'Disputes', description: "The merchant's PayPal disputes, one row each. A dispute the merchant is about to lose (this week or otherwise) is one that is still open and that JUNCO says to Accept; Days left says how soon. This is the same rule as the desk's At risk this week panel.", data: toRows(cases.data ?? []), fields: FIELDS }] }), [rowsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <AgStudioProvider licenseKey={studioKey}>
      <div className="jd-app">
      <header className="jd-topbar">
        <strong>JUNCO</strong><span className="jd-muted">Works your PayPal disputes; money moves wait for your OK</span><CaseBanner page={page} /><StatusLine />
        <nav aria-label="Pages">
          <button type="button" className="jd-tab" aria-expanded={start} onClick={() => setStart(!start)}>Start here</button>
          {PAGES.map(([id, label]) => (
            <button key={id} type="button" className="jd-tab" aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}>{label}</button>
          ))}
        </nav>
      </header>
      {start && <StartHere go={setPage} close={() => setStart(false)} />}
      <ReplayDrawer />
      <div className="jd-host">
        {/* Studio mounts once the first cases arrive: native widgets (filters, grid) build their first query on mount. */}
        {!cases.data && !cases.error ? <div className="jd-empty">Loading disputes from PayPal...</div> : <AgStudio
          key={page}
          // Desk widgets read the desk API themselves; the Insights page runs on this Studio data source.
          data={data as any}
          widgets={widgets}
          initialState={{ ...withSavedDesk(layout), selectedPageId: page } as any}
          onStateUpdated={saveDesk}
          mode={ai && page === 'desk' ? 'edit' : 'view'}
          theme={theme}
          // The desk is a fixed layout for the judges: no filter panel in view mode.
          panels={{ view: { left: [], right: [] }, edit: { left: [], right: ['ai'] } }}
          {...(ai ? { ai, aiToolDisplay: aiToolDisplayAll } : {})}
        />}
      </div>
      </div>
    </AgStudioProvider>
  );
}
