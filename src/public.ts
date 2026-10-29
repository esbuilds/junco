// The judges' door (Oct 29): what anyone may see without the desk password. Read-only pages over the desk's own records:
// /judges, incident pages, receipts and their JSON, the incident list, and run pages, plus the incident what-if, which
// only re-runs decide() on a recorded request (paypal_calls 0, nothing saved). No Claude call, no PayPal call, no write.
// The desk serves these as the PUBLIC_SESSION actor (never the owner, no cookie); incident.ts hides a visitor's own
// shopping runs from it. Everything else stays behind the password. check-public pins both lists.
export const PUBLIC_SESSION = 'public'; // never a desk session: those are UUIDs (actorOf)
export const PUBLIC_GET = /^\/(?:judges|api\/incidents|incident\/[\w-]{1,64}(?:\/receipt)?|api\/incident\/[\w-]{1,64}|run\/[\w-]{1,64})$/;
export const PUBLIC_POST = /^\/api\/incident\/[\w-]{1,64}\/what-if$/;
export const isPublic = (method: string | undefined, path: string) =>
  (method === 'GET' && PUBLIC_GET.test(path)) || (method === 'POST' && PUBLIC_POST.test(path));
