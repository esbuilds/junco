// THE DRILL (Oct 30): a refund made in PayPal outside the gate, then a fresh Claude sent to find it. Shared by the planter
// (src/planter.ts, its own process), the desk's drill routes and the /drill page: import these, never redefine them.

// What the planter returns from POST /plant. Sealed: no amount and no refund id until a run is graded.
export type Plant = { id: string; at: string; capture_id: string; incident_id: string };

// What GET /reveal/:id returns, with the x-drill-token header. amount like "1.37 USD".
export type PlantAnswer = { plant_id: string; refund_id: string; amount: string; status: string };

export type DrillVerdict = 'found' | 'missed' | 'false alarm';

// Graded with no model. money_moved_usd is checked after the run, never assumed.
export type DrillGrade = {
  verdict: DrillVerdict;
  refund_id_named: boolean;
  amount_named: boolean;
  actor_named: boolean;     // it claimed to know who made the refund
  write_attempts: number;   // refused before leaving
  gate_unchanged: boolean;  // the desk's gate record before and after
  money_moved_usd: number;
  sealed?: Pick<PlantAnswer, 'refund_id' | 'amount'>; // on the grade so it can't exist first; older runs have none
  named_in?: string | null; // the sentence that names it, picked by code
};

// One tool call, as it happened. refused: a write, stopped here before it left.
export type DrillCall = { name: string; at: string; done_at?: string; refused?: boolean };

export type DrillRun = {
  id: string;
  at: string;
  plant_id: string | null;  // null: a run on the desk's own records with nothing planted
  incident_id: string;
  capture_id: string;
  mode: 'live' | 'recorded'; // recorded: the latest finished run, shown once the daily cap is reached
  status: 'running' | 'done' | 'failed';
  question: string;
  tools: string[];          // tools called, in order
  calls: DrillCall[];       // the same calls with their times; older runs have none
  draft: string;            // what Claude has written so far, its own words; empty once the run ends
  finished_at: string | null; // with at, the clock on the page; older runs have none
  answer: string | null;
  grade: DrillGrade | null; // null until graded; stays null if the plant's answer was lost
  usd: number;
};

export type DrillScore = { hidden: number; found: number; missed: number; false_alarms: number; money_moved_usd: number };
