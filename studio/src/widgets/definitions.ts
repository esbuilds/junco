// Studio custom widget definitions. Each widget is a React component; state lives in the desk server, not in Studio.
import { createWidgets, type AgWidgetDefinition } from 'ag-studio-react';
import { ActivityWidget } from './ActivityWidget';
import { CaseWidget } from './CaseWidget';
import { HoldsWidget } from './HoldsWidget';
import { QueueWidget } from './QueueWidget';

// Widgets without a data mapping: the form is just the standard setup and title tabs.
const form = ({ createDefaults }: { createDefaults: (p: object) => any }) => createDefaults({});

const defs = [
  { id: 'junco-queue', label: 'Dispute queue', comp: QueueWidget, defaultSize: { width: 12, height: 9 }, minSize: { width: 6, height: 5 } },
  { id: 'junco-case', label: 'Case', comp: CaseWidget, defaultSize: { width: 6, height: 16 }, minSize: { width: 4, height: 8 } },
  { id: 'junco-holds', label: 'Waiting for you', comp: HoldsWidget, defaultSize: { width: 6, height: 6 }, minSize: { width: 4, height: 4 } },
  { id: 'junco-activity', label: 'Agent activity', comp: ActivityWidget, defaultSize: { width: 12, height: 8 }, minSize: { width: 6, height: 5 } },
].map((d) => ({ ...d, form })) as unknown as AgWidgetDefinition[];

export const JUNCO_WIDGET_IDS = defs.map((d) => d.id);

export const widgets = createWidgets({
  additionalTypes: defs as any,
  menu: [{ label: 'JUNCO desk', widgetIds: JUNCO_WIDGET_IDS as any }],
} as any);
