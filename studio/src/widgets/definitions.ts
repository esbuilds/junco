// Studio custom widget definitions. Each widget is a React component; state lives in the desk server, not in Studio.
import { createWidgets, type AgWidgetDefinition } from 'ag-studio-react';
import { ActivityWidget } from './ActivityWidget';
import { AtRiskWidget } from './AtRiskWidget';
import { CaseWidget } from './CaseWidget';
import { HoldsWidget } from './HoldsWidget';
import { LedgerWidget } from './LedgerWidget';
import { OrdersWidget } from './OrdersWidget';
import { PolicyWidget } from './PolicyWidget';
import { TryWidget } from './TryWidget';
import { QueueWidget } from './QueueWidget';
import { StatsWidget } from './StatsWidget';

// Widgets without a data mapping: the form is just the standard setup and title tabs.
const form = ({ createDefaults }: { createDefaults: (p: object) => any }) => createDefaults({});

const defs = [
  { id: 'junco-stats', label: 'Summary stats', comp: StatsWidget, defaultSize: { width: 12, height: 4 }, minSize: { width: 6, height: 4 } },
  { id: 'junco-at-risk', label: 'At risk this week', comp: AtRiskWidget, defaultSize: { width: 7, height: 7 }, minSize: { width: 4, height: 4 } },
  { id: 'junco-ledger', label: 'Outcomes', comp: LedgerWidget, defaultSize: { width: 3, height: 7 }, minSize: { width: 3, height: 4 } },
  { id: 'junco-policy', label: 'Policy', comp: PolicyWidget, defaultSize: { width: 6, height: 14 }, minSize: { width: 4, height: 8 } },
  { id: 'junco-orders', label: 'Shipment watch', comp: OrdersWidget, defaultSize: { width: 12, height: 20 }, minSize: { width: 6, height: 8 } },
  { id: 'junco-try', label: 'Try the brain', comp: TryWidget, defaultSize: { width: 8, height: 30 }, minSize: { width: 6, height: 10 } },
  { id: 'junco-queue', label: 'Dispute queue', comp: QueueWidget, defaultSize: { width: 7, height: 12 }, minSize: { width: 6, height: 5 } },
  { id: 'junco-case', label: 'Case', comp: CaseWidget, defaultSize: { width: 5, height: 12 }, minSize: { width: 4, height: 8 } },
  { id: 'junco-holds', label: 'Waiting for you', comp: HoldsWidget, defaultSize: { width: 4, height: 6 }, minSize: { width: 3, height: 2 } },
  { id: 'junco-activity', label: 'Agent activity', comp: ActivityWidget, defaultSize: { width: 8, height: 6 }, minSize: { width: 6, height: 4 } },
].map((d) => ({ ...d, form })) as unknown as AgWidgetDefinition[];

export const JUNCO_WIDGET_IDS = defs.map((d) => d.id);

export const widgets = createWidgets({
  additionalTypes: defs as any,
  menu: [{ label: 'JUNCO desk', widgetIds: JUNCO_WIDGET_IDS as any }],
} as any);
