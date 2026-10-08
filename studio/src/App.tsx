import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { widgets } from './widgets/definitions';
import './styles.css';

// Pre-built desk layout: queue across the top, activity under it, case and holds side by side.
const layout = {
  pages: [{
    id: 'desk',
    layout: { columns: 12, rowHeight: 24, widgetPadding: 8, pagePadding: 16 },
    widgets: {
      queue: { id: 'queue', type: 'junco-queue', dataMapping: {} },
      activity: { id: 'activity', type: 'junco-activity', dataMapping: {} },
      holds: { id: 'holds', type: 'junco-holds', dataMapping: {} },
      case: { id: 'case', type: 'junco-case', dataMapping: {} },
    },
    widgetLayout: {
      holds: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 8 },
      activity: { xTrack: 0, yTrack: 8, xSpan: 12, ySpan: 9 },
      queue: { xTrack: 0, yTrack: 17, xSpan: 7, ySpan: 16 },
      case: { xTrack: 7, yTrack: 17, xSpan: 5, ySpan: 16 },
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
