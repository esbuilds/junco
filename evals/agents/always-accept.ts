// DisputeBench baseline: the "just refund it" agent. Accepts every dispute it is allowed to.
export async function decide(dispute: any) {
  const allowed = (dispute.links ?? []).map((l: any) => l.rel);
  return { decision: allowed.includes('accept_claim') ? 'accept' : 'wait' };
}
