import { useState } from 'react';
import { api } from '../api';
import { usePoll } from '../store';

// The owner's kill switch: sign every Claude connector out at once. The next tool call from any of them fails with a
// plain message and the client has to sign in again. Visitors never see it (the server refuses them too).
// compact: the header button (owner only); the full line with the connector count stays on Break the mandate.
export function KillSwitch({ compact }: { compact?: boolean }) {
  const { data } = usePoll<{ owner?: boolean; connectors?: number }>('/api/status', 60000);
  const [done, setDone] = useState<string | null>(null);
  if (!data?.owner) return null;
  const revoke = async () => {
    if (!confirm('Disconnect every connector? Each connected Claude has to sign in again before its next tool call.')) return;
    try { const r = await api<{ at: string; sessions: number }>('/api/connectors/revoke', { method: 'POST' }); setDone(`Disconnected ${r.sessions} signed-in connector${r.sessions === 1 ? '' : 's'} at ${r.at.slice(11, 16)} UTC.`); }
    catch (e: any) { setDone(`Not disconnected: ${e.message}`); }
  };
  if (compact) return <button type="button" className="jd-btn jd-btn-sm" title={done ?? `${data.connectors ?? 0} connector${data.connectors === 1 ? '' : 's'} signed in`} onClick={revoke}>{done ? 'Disconnected' : 'Disconnect agents'}</button>;
  return (
    <p className="jd-muted">
      {done ?? `${data.connectors ?? 0} connector${data.connectors === 1 ? '' : 's'} signed in.`}{' '}
      <button type="button" className="jd-btn jd-danger" onClick={revoke}>Disconnect every connector</button>
    </p>
  );
}
