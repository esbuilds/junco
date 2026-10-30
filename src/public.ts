// The judges' door (Oct 29): what anyone may see without the desk password. Read-only pages over the desk's own records:
// /judges, incident pages, receipts and their JSON, the incident list, and run pages, plus the incident what-if, which
// only re-runs decide() on a recorded request (paypal_calls 0, nothing saved). None of those calls Claude or PayPal or writes.
// The drill is the exception (Oct 30): /drill, its score and its runs are open too, and a run does call Claude and read
// PayPal, through read tools, capped at 10 a day and metered through spend.ts (drill.ts). It moves no money.
// The desk serves these as the PUBLIC_SESSION actor (never the owner, no cookie); incident.ts hides a visitor's own
// shopping runs from it. Everything else stays behind the password. check-public pins both lists.
export const PUBLIC_SESSION = 'public'; // never a desk session: those are UUIDs (actorOf)
export const PUBLIC_GET = /^\/(?:judges|drill|api\/drill\/score|api\/drill\/run\/[\w-]{1,64}|api\/incidents|incident\/[\w-]{1,64}(?:\/receipt)?|api\/incident\/[\w-]{1,64}|run\/[\w-]{1,64})$/;
export const PUBLIC_POST = /^\/api\/(?:incident\/[\w-]{1,64}\/what-if|drill\/run)$/;
export const isPublic = (method: string | undefined, path: string) =>
  (method === 'GET' && PUBLIC_GET.test(path)) || (method === 'POST' && PUBLIC_POST.test(path));
