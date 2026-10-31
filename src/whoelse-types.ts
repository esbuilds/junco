// WHO ELSE? (Oct 30): one dispute shows a mistake the shopping agent made, and this finds every other purchase where it made
// the same one, from the reasons it recorded when it bought. Shared by src/whoelse.ts, the desk's routes, public/who-else.html
// and the Studio widget: import these, never redefine them.

// complained: an open dispute on it; the dispute desk works it and no refund is planned here.
// silent: the same mistake and nobody has complained; this is who the plan helps.
// repaired: the same mistake, and PayPal shows the whole payment already refunded.
// not_same: the agent's recorded reason doesn't show this mistake.
// unclear: anything code couldn't confirm (a quote that isn't word for word, PayPal unread, an unusable status). Stays out of the plan.
export type Bucket = 'complained' | 'silent' | 'repaired' | 'not_same' | 'unclear';

export type QuoteField = 'instruction' | 'reason' | 'listing';
export type Quote = { field: QuoteField; text: string }; // text appears word for word in that recorded field, checked by code

export type Member = {
  incident_id: string;          // links /incident/<id>
  capture_id: string | null;
  sku: string;
  paid: string;                 // '62.00'
  instruction: string;          // as recorded at purchase, never rewritten
  reason: string;               // the agent's words, as recorded at purchase
  listing: string;              // the listing the agent saw, as recorded at purchase
  bucket: Bucket;
  why: string;                  // one plain sentence
  quotes: Quote[];              // what the model pointed at, after the code check
  dispute_id: string | null;
  payment_status: string | null; // PayPal's, from reconciled(); null when PayPal didn't answer
  refunded: string;             // what PayPal shows already paid back on this capture, dispute holds excluded
  remaining: string;            // paid minus refunded; the most a remedy can be
  fingerprint: 'match' | 'mismatch' | 'not recorded' | 'before fingerprints';
};

export type Remedy = {
  capture_id: string;
  incident_id: string;
  amount: string;               // set by code from `remaining`, never by a model
  currency: 'USD';
  note_to_payer: string;        // at most 255 characters; goes to the buyer through PayPal's refund
  hold_id: string | null;       // null until the owner plans it
  hold_status: string | null;   // read from the hold each time, so expiry shows
  refund_id: string | null;     // PayPal's, once a hold ran
  refund_status: string | null;
};

// A proposed change to one listing. Records already made keep the listing the agent saw.
export type Correction = { sku: string; text: string; at: string | null }; // at: when the owner applied it; null while proposed

// The same ask, after a correction, run through the shopping agent with no order placed.
export type Trial = { at: string; instruction: string; budget: string; outcome: 'bought' | 'declined'; sku: string | null; reason: string };

// What a buyer's own shopping agent did with the store's notice. asked: it asked for the remedy and the gate holds a refund for the
// owner. declined: it read the notice and said this doesn't apply to what its person asked for, a real, good outcome. failed: nothing was held.
export type AgentNotice = { capture_id: string; incident_id: string; at: string; outcome: 'asked' | 'declined' | 'failed'; reason: string; hold_id: string | null };

export type WhoElseRun = {
  id: string;
  at: string;
  seed: string;                 // the incident it started from
  cause: { summary: string; quotes: Quote[] }; // summary: the owner's own note on the seed, word for word; quotes: the seed's records that show it
  members: Member[];            // every purchase looked at, seed included
  draft_note: string;           // what note_to_payer will say, built by code from the owner's note, shown before the owner plans
  notice: string;               // what a buyer's agent reads, built by code from the owner's note, shown before the owner sends it
  remedies: Remedy[];           // empty until the owner plans or a buyer's agent asks; one per silent purchase
  notices: AgentNotice[];       // one per purchase told; [] on any run stored before agents could be told
  corrections: Correction[];
  trials: Trial[];
  mode: 'live' | 'recorded';    // live: this run's PayPal reads answered. recorded: shown after the cap, from a finished run
  model: string;
  cost_usd: number;
};

export type WhoElseScore = { runs: number; purchases_read: number; silent_found: number; refunds_proposed: number; refunds_confirmed: number; agents_told: number; agents_asked: number; agents_declined: number }; // agents_*: purchases, not buyers

// What the owner says went wrong on one purchase. The model never decides this: PayPal's reason code names no cause, and the
// sandbox drops the buyer's words. A run needs a note on its seed.
export type SeedNote = { incident_id: string; title: string; text: string; at: string };

// GET  /api/who-else                      public   { latest: WhoElseRun | null, score: WhoElseScore, left: number, agents_left: number, seeds: SeedNote[] }
// POST /api/who-else/note { seed, text }  owner    sets the note on a seed
// POST /api/who-else/run  { seed }        public   runs the finder on a seed with a note, capped; moves no money and makes no hold
// GET  /api/who-else/run/<id>             public   a run, with hold and refund states read fresh
// POST /api/who-else/run/<id>/plan  { captures: string[] }   owner   one held create_refund per capture, from `silent` only
// POST /api/who-else/run/<id>/notify { captures: string[] } owner   tells each purchase's agent, from `silent` only; capped; an agent that asks makes one held create_refund
// POST /api/who-else/run/<id>/approve-all                    owner   runs each pending hold in order, one by one, through decideHold
// POST /api/who-else/run/<id>/correct { sku, text }          owner   applies a listing correction, then runs 3 trials
