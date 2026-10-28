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
import { T, isDark } from './theme';
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
    // BLACK BOX: one AI purchase start to finish, from the records, with the gate's what-if.
    id: 'incident',
    layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
    widgets: { incident: { id: 'incident', type: 'junco-incident', dataMapping: {} } },
    widgetLayout: { incident: { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 34 } },
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
  if (narrow) return; // the phone's stacked layout is not the desk layout
  const desk = (e?.state?.pages ?? []).find((p: any) => p.id === 'desk');
  if (!desk?.widgetLayout) return;
  try { localStorage.setItem(DESK_LAYOUT_KEY, JSON.stringify(desk.widgetLayout)); } catch { /* not saved; the layout still works */ }
}

// JUNCO theme for Studio's native widgets (Insights charts and filters): the desk tokens (src/theme.ts) and Geist.
// Chart fills: the zinc ramp plus copper and one slate, so charts don't bring the rainbow back.
const C = { bg: T.bg, surface: T.surface, ink: T.ink, muted: T.muted, line: T.line, accent: T.accent,
  fills: isDark ? ['#e4e4e7', '#ed916b', '#8fa3b8', '#a1a1aa', '#71717a', '#c69a85', '#d4d4d8', '#52525b']
    : [T.ink, T.attn, '#5b7083', T.muted, T.faint, '#9a6b55', '#3f3f46', '#b8b8c0'] };
const theme = studioTheme.withParams({
  fontFamily: 'Geist, system-ui, sans-serif', chartFontFamily: 'Geist, system-ui, sans-serif',
  backgroundColor: C.surface, textColor: C.ink, borderColor: C.line,
  studioCanvasBackgroundColor: C.bg, studioWidgetBackgroundColor: C.surface,
  studioWidgetTitleTextColor: C.ink, studioWidgetSubtitleTextColor: C.muted, studioWidgetCaptionTextColor: C.muted,
  studioToggleButtonActiveBackgroundColor: C.accent, studioToggleButtonActiveBorderColor: C.accent, studioToggleButtonActiveColor: C.accent,
  chartTextColor: C.ink, chartSubtleTextColor: C.muted, chartGridLineColor: C.line, chartAxisLineColor: C.muted,
  ...Object.fromEntries(C.fills.map((c, i) => [`chartPaletteFills${i + 1}Color`, c])),
  // Studio's own widgets (Insights charts, filters) match the desk's panels: 8px corners, a 1px line,
  // 14px semibold titles, 13px subtitles and captions.
  studioWidgetBorderRadius: 8, studioWidgetBorder: { width: 1, color: C.line }, studioWidgetPadding: 16,
  studioWidgetTitleFontSize: 14, studioWidgetTitleFontWeight: 600, studioWidgetSubtitleFontSize: 13, studioWidgetCaptionFontSize: 13,
  accentColor: C.accent,
} as any);

// Studio shows no page tabs in view mode, so the desk has its own slim header to switch pages.
// STUDIO_AI=1 at build time: the Desk opens with AG Studio's AI assistant (an edit-mode panel). Off: the desk as before.
const ai = __STUDIO_AI__ ? aiSetup() : undefined;

const PAGES = [['desk', 'Desk'], ['orders', 'Orders'], ['incident', 'Incident'], ['insights', 'Insights'], ['policy', 'Policy'], ['mandate', 'Break the mandate'], ['try', 'Try it']] as const;

// The desk's runtime key (index.html, from its env) wins; the dev server's build-time one is the fallback.
const studioKey = (window as { JUNCO_STUDIO_KEY?: string }).JUNCO_STUDIO_KEY || __AG_STUDIO_KEY__;

// Phones (coldjudge F1): below 900 px the Desk is view mode, so the assistant panel never covers the queue and holds,
// and the one-panel pages span the full width. Read once at load.
const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches;
// Every panel full width, stacked in reading order (top to bottom, then left to right).
const stack = (wl: Record<string, { xTrack: number; yTrack: number; xSpan: number; ySpan: number }>) => {
  let y = 0;
  return Object.fromEntries(Object.entries(wl).sort(([, a], [, b]) => a.yTrack - b.yTrack || a.xTrack - b.xTrack)
    .map(([k, v]) => { const at = y; y += v.ySpan + 2; return [k, { ...v, xTrack: 0, xSpan: 12, yTrack: at, ySpan: v.ySpan + 2 }]; })); // +2: text wraps more
};
const fit = (l: typeof layout) => !narrow ? l : { ...l, pages: l.pages.map((p: any) => ({ ...p, widgetLayout: stack(p.widgetLayout) })) };

export function App() {
  // The owner (cookie) keeps Studio's widget toolbar; visitors don't get its close icon (coldjudge F10).
  const owner = usePoll<{ owner?: boolean }>('/api/status', 60000).data?.owner;
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
      <div className={owner ? 'jd-app' : 'jd-app jd-visitor'}>
      <header className="jd-topbar">
        <strong><svg className="jd-mark" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 32V9M32 32L51.92 43.5M32 32V55M32 32L12.08 43.5M32 32L12.08 20.5" fill="none" stroke="currentColor" strokeWidth="6.4" strokeLinecap="round" /><circle cx="50.19" cy="21.5" r="4.6" fill="var(--jd-accent)" /></svg>JUNCO</strong><span className="jd-muted">Works your PayPal disputes; money moves wait for your OK</span><CaseBanner page={page} /><StatusLine />
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
          initialState={{ ...fit(withSavedDesk(layout)), selectedPageId: page } as any}
          onStateUpdated={saveDesk}
          mode={ai && page === 'desk' && !narrow ? 'edit' : 'view'}
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
