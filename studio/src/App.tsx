import { useEffect, useMemo, useState } from 'react';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { studioTheme } from 'ag-studio';
import { widgets } from './widgets/definitions';
import { KillSwitch } from './widgets/KillSwitch';
import { CaseBanner } from './widgets/CaseBanner';
import { StatusLine } from './widgets/StatusLine';
import { ReplayDrawer } from './widgets/ReplayDrawer';
import { BOOK_FIELDS, booksPage, FIELDS, insightsPage, toRows } from './insights';
import { usePoll } from './store';
import { aiSetup, aiToolDisplayAll } from './studioAi';
import type { CaseRow } from './api';
import type { BooksRow } from '../../src/incident-types';
import { T, isDark } from './theme';
import { DESK_LAYOUT_KEY } from './ui';
import './styles.css';

// Pre-built desk layout (UI polish): KPI strip and Waiting for your OK in the main column, Start here and Agent
// activity in the right rail; then queue and case, the Gate record, Dispute this store and At risk.
// Simulated lifecycle outcomes moved to Insights (v3.14).
// Waiting for your OK hugs its three rows (Panel hug); its slot is sized to them so no gap opens under the card.
// Rows wrap more below 1400 px, so the slot is a track taller there. The rail and the queue follow it.
const HOLDS = typeof innerWidth === 'number' && innerWidth >= 1400 ? 15 : 16;
const layout = {
  pages: [{
    id: 'desk',
    layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
    widgets: {
      stats: { id: 'stats', type: 'junco-stats', dataMapping: {} },
      holds: { id: 'holds', type: 'junco-holds', dataMapping: {} },
      start: { id: 'start', type: 'junco-start', dataMapping: {} },
      activity: { id: 'activity', type: 'junco-activity', dataMapping: {} },
      queue: { id: 'queue', type: 'junco-queue', dataMapping: {} },
      case: { id: 'case', type: 'junco-case', dataMapping: {} },
      gate: { id: 'gate', type: 'junco-gate-record', dataMapping: {} },
      store: { id: 'store', type: 'junco-store-dispute', dataMapping: {} },
      risk: { id: 'risk', type: 'junco-at-risk', dataMapping: {} },
    },
    widgetLayout: {
      stats: { xTrack: 0, yTrack: 0, xSpan: 9, ySpan: 5 },
      holds: { xTrack: 0, yTrack: 5, xSpan: 9, ySpan: HOLDS },
      start: { xTrack: 9, yTrack: 0, xSpan: 3, ySpan: 15 },
      activity: { xTrack: 9, yTrack: 15, xSpan: 3, ySpan: HOLDS + 8 },
      queue: { xTrack: 0, yTrack: 5 + HOLDS, xSpan: 9, ySpan: 18 },
      case: { xTrack: 0, yTrack: 23 + HOLDS, xSpan: 12, ySpan: 22 },
      gate: { xTrack: 0, yTrack: 45 + HOLDS, xSpan: 12, ySpan: 24 },
      store: { xTrack: 0, yTrack: 69 + HOLDS, xSpan: 12, ySpan: 14 },
      risk: { xTrack: 0, yTrack: 83 + HOLDS, xSpan: 7, ySpan: 19 },
    },
  }, insightsPage, booksPage, {
    // Who else?: the other purchases where the agent made the same mistake, and the owner's plan for them.
    id: 'who-else',
    layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
    widgets: { 'who-else': { id: 'who-else', type: 'junco-who-else', dataMapping: {} } },
    widgetLayout: { 'who-else': { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 100 } }, // tall enough with every group open and a row's detail
  }, {
    // Break the mandate: the visitor plays the buyer; the seller side is real on a never-shipped sandbox case.
    id: 'mandate',
    layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
    widgets: { mandate: { id: 'mandate', type: 'junco-challenge', dataMapping: {} } },
    widgetLayout: { mandate: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 44 } },
  }, {
    // The Escape room: Break the mandate as five rooms of rising difficulty, same runs, same gate, same caps.
    id: 'escape',
    layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
    widgets: { escape: { id: 'escape', type: 'junco-escape', dataMapping: {} } },
    widgetLayout: { escape: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 44 } },
  }, {
    // BLACK BOX: one AI purchase start to finish, from the records, with the gate's what-if.
    id: 'incident',
    layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
    widgets: { incident: { id: 'incident', type: 'junco-incident', dataMapping: {} } },
    widgetLayout: { incident: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 34 } },
  }, {
    // Scenario mode: synthetic cases through the real recommender, no PayPal calls.
    id: 'try',
    layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
    widgets: { try: { id: 'try', type: 'junco-try', dataMapping: {} } },
    widgetLayout: { try: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 60 } },
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
    widgetLayout: { policy: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 40 } },
  }],
  selectedPageId: 'desk',
};

// v3.14 item 5: the owner can resize Desk panels from any edge (Studio's edit mode, on whenever the assistant is); this
// browser remembers the sizes. Only positions of the desk's own panels are kept, so a stale save can't add or drop a panel.
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
// Chart fills: the zinc ramp plus one slate, no copper (copper means the owner must act), so charts stay calm.
const C = { bg: T.bg, surface: T.surface, ink: T.ink, muted: T.muted, line: T.line, accent: T.accent,
  fills: isDark ? ['#a1a1aa', '#52525b', '#8fa3b8', '#3f3f46', '#d4d4d8', '#5b7083', '#71717a', '#27272a']
    : ['#52525b', '#a1a1aa', '#5b7083', '#d4d4d8', '#27272a', '#8fa3b8', '#71717a', '#e4e4e7'] };
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

const PAGES = [['desk', 'Desk'], ['orders', 'Orders'], ['incident', 'Incidents'], ['books', 'Books'], ['who-else', 'Who else?'], ['insights', 'Insights'], ['policy', 'Policy']] as const;
// Demo pages sit after a divider so they don't read as everyday merchant work.
const TEST_PAGES = [['escape', 'Escape room'], ['mandate', 'Break the mandate'], ['try', 'Try it']] as const;

// The desk's runtime key (index.html, from its env) wins; the dev server's build-time one is the fallback.
const studioKey = (window as { JUNCO_STUDIO_KEY?: string }).JUNCO_STUDIO_KEY || __AG_STUDIO_KEY__;

// Phones (coldjudge F1): below 900 px the Desk opens in view mode, so the assistant panel never covers the queue and
// holds unless asked (Ask JUNCO), and the one-panel pages span the full width. Read once at load.
const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches;
// Every panel full width, stacked in reading order (top to bottom, then left to right). PHONE_SPAN: panels that change
// shape on a phone (the KPI strip goes 2x2; the holds table stacks its rows).
const PHONE_SPAN: Record<string, number> = { stats: 12, holds: 26, gate: 46, store: 40, risk: 22, books: 46, incident: 72, bookRecon: 5, bookStatus: 8, bookPrint: 5, bookReplay: 5, 'who-else': 190 }; // Books' filters: full width needs less height, so the table stays near the top
const stack = (wl: Record<string, { xTrack: number; yTrack: number; xSpan: number; ySpan: number }>) => {
  let y = 0;
  return Object.fromEntries(Object.entries(wl).sort(([, a], [, b]) => a.yTrack - b.yTrack || a.xTrack - b.xTrack)
    .map(([k, v]) => { const h = PHONE_SPAN[k] ?? v.ySpan + 2; const at = y; y += h; return [k, { ...v, xTrack: 0, xSpan: 12, yTrack: at, ySpan: h }]; })); // +2: text wraps more
};
const fit = (l: typeof layout) => !narrow ? l : { ...l, pages: l.pages.map((p: any) => ({ ...p, widgetLayout: stack(p.widgetLayout) })) };

export function App() {
  // The owner (cookie) keeps Studio's widget toolbar; visitors don't get its close icon (coldjudge F10).
  const owner = usePoll<{ owner?: boolean }>('/api/status', 60000).data?.owner;
  // Ask JUNCO opens AG Studio's assistant (Studio's edit mode, with its AI panel); closed, the Desk is view mode.
  const [assistant, setAssistant] = useState(false);
  useEffect(() => { const on = (e: Event) => setPage((e as CustomEvent).detail); window.addEventListener('jd-go', on); return () => window.removeEventListener('jd-go', on); }, []);
  const [page, setPage] = useState<string>(() => new URLSearchParams(location.search).get('page') ?? 'desk'); // ?page= links (the counter's Gate record link)
  // Live disputes for the Insights page; only the rows change after first render (see insights.ts).
  const cases = usePoll<CaseRow[]>('/api/cases', 15000);
  // A new data object restarts Studio's chart queries; the 15 s poll returns a new array every time, so only real
  // changes to the rows count (charts took about 30 s to settle when every poll counted).
  const rowsKey = JSON.stringify(cases.data ?? []);
  // The Books read PayPal for every purchase, so only their own page polls them.
  const books = usePoll<BooksRow[]>(page === 'books' ? '/api/books' : null, 60000);
  const booksKey = JSON.stringify(books.data ?? []);
  const data = useMemo(() => ({ sources: [{ id: 'disputes', name: 'Disputes', description: "The merchant's PayPal disputes, one row each. A dispute the merchant is about to lose (this week or otherwise) is one that is still open and that JUNCO says to Accept; Days left says how soon. This is the same rule as the desk's At risk this week panel.", data: toRows(cases.data ?? []), fields: FIELDS },
    { id: 'books', name: 'Books', description: "The store's AI purchases, one row each: what PayPal says beside what the desk recorded. It fills when the Books page is open.", data: books.data ?? [], fields: BOOK_FIELDS }] }), [rowsKey, booksKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = (!cases.data && !cases.error) ? 'Loading disputes from PayPal...' : page === 'books' && !books.data ? books.error ?? 'Reading the books from PayPal...' : null;
  return (
    <AgStudioProvider licenseKey={studioKey}>
      <div className={owner ? 'jd-app' : 'jd-app jd-visitor'}>
      <header className="jd-topbar">
        <div className="jd-topbar-row">
          <strong className="jd-brand"><svg className="jd-mark" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 32V9M32 32L51.92 43.5M32 32V55M32 32L12.08 43.5M32 32L12.08 20.5" fill="none" stroke="currentColor" strokeWidth="6.4" strokeLinecap="round" /><circle cx="50.19" cy="21.5" r="4.6" fill={isDark ? '#5fb497' : '#1f5c4a'} /></svg>JUNCO</strong>
          <span className="jd-slash" aria-hidden="true">/</span>
          <CaseBanner page={page} />
          <span className="jd-grow" />
          <StatusLine />
          {ai && <button type="button" className="jd-btn jd-btn-sm" aria-pressed={assistant} onClick={() => { setAssistant(!assistant); setPage('desk'); }}>{assistant ? 'Close assistant' : 'Ask JUNCO'}</button>}
          <KillSwitch compact />
        </div>
        <nav aria-label="Pages" className="jd-tabs">
          {PAGES.map(([id, label]) => (
            <button key={id} type="button" className="jd-tab" aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}>{label}</button>
          ))}
          <span className="jd-tabs-sep" aria-hidden="true" /><span className="jd-tabs-group">Test it</span>
          {TEST_PAGES.map(([id, label]) => (
            <button key={id} type="button" className="jd-tab" aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}>{label}</button>
          ))}
        </nav>
      </header>
      {page === 'desk' && (
        <div className="jd-pagehead">
          <h1>Desk</h1>
        </div>
      )}
      <ReplayDrawer />
      <div className="jd-host">
        {/* Studio mounts once the first cases arrive: native widgets (filters, grid) build their first query on mount. */}
        {waiting ? <div className="jd-empty">{waiting}</div> : <AgStudio
          key={page}
          // Desk widgets read the desk API themselves; the Insights page runs on this Studio data source.
          data={data as any}
          widgets={widgets}
          initialState={{ ...fit(withSavedDesk(layout)), selectedPageId: page } as any}
          onStateUpdated={saveDesk}
          // Phones too, but only on request: Ask JUNCO opens the assistant over the stacked desk; closing it returns to view.
          mode={ai && page === 'desk' && assistant ? 'edit' : 'view'}
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
