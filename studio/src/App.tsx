import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { widgets } from './widgets/definitions';
import './styles.css';

// Pre-built desk layout: summary stats, then holds and activity, then at-risk and queue on the left, case on the right.
const layout = {
  pages: [{
    id: 'desk',
    layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
    widgets: {
      stats: { id: 'stats', type: 'junco-stats', dataMapping: {} },
      holds: { id: 'holds', type: 'junco-holds', dataMapping: {} },
      activity: { id: 'activity', type: 'junco-activity', dataMapping: {} },
      risk: { id: 'risk', type: 'junco-at-risk', dataMapping: {} },
      queue: { id: 'queue', type: 'junco-queue', dataMapping: {} },
      case: { id: 'case', type: 'junco-case', dataMapping: {} },
    },
    widgetLayout: {
      stats: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 4 },
      holds: { xTrack: 0, yTrack: 4, xSpan: 6, ySpan: 8 },
      activity: { xTrack: 6, yTrack: 4, xSpan: 6, ySpan: 8 },
      risk: { xTrack: 0, yTrack: 12, xSpan: 7, ySpan: 7 },
      queue: { xTrack: 0, yTrack: 19, xSpan: 7, ySpan: 16 },
      case: { xTrack: 7, yTrack: 12, xSpan: 5, ySpan: 23 },
    },
  }],
  selectedPageId: 'desk',
};

export function App() {
  return (
    <AgStudioProvider licenseKey={__AG_STUDIO_KEY__}>
      <div className="jd-host">
        <AgStudio
          // The desk has no Studio data sources yet: each widget reads the desk API itself.
          data={{ sources: [] }}
          widgets={widgets}
          initialState={layout as any}
          mode="view"
          // The desk is a fixed layout for the judges: no filter panel in view mode.
          panels={{ view: { left: [], right: [] } }}
        />
      </div>
    </AgStudioProvider>
  );
}
