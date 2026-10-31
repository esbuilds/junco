import { useState } from 'react';
import { api } from '../api';
import { usePoll } from '../store';
import { ConfirmDialog } from './ConfirmDialog';

// The owner's kill switch: sign every Claude connector out at once. The next tool call from any of them fails with a
// plain message and the client has to sign in again. Visitors never see it (the server refuses them too).
// compact: the header button (owner only); the full line with the connector count stays on Break the mandate.
export function KillSwitch({ compact }: { compact?: boolean }) {
  const { data } = usePoll<{ owner?: boolean; connectors?: number }>('/api/status', 60000);
  const [done, setDone] = useState<string | null>(null), [asking, setAsking] = useState(false), [busy, setBusy] = useState(false);
  if (!data?.owner) return null;
  const n = data.connectors ?? 0;
  const revoke = async () => {
    setBusy(true);
    try { const r = await api<{ at: string; sessions: number }>('/api/connectors/revoke', { method: 'POST' }); setDone(`Disconnected ${r.sessions} signed-in connector${r.sessions === 1 ? '' : 's'} at ${r.at.slice(11, 16)} UTC.`); }
    catch (e: any) { setDone(`Not disconnected: ${e.message}`); }
    finally { setBusy(false); setAsking(false); }
  };
  const dialog = asking && (
    <ConfirmDialog title="Disconnect every connector?" confirm="Disconnect" danger busy={busy} onConfirm={revoke} onCancel={() => setAsking(false)}>
      <p>Each connected Claude has to sign in again before its next tool call. {n} {n === 1 ? 'is' : 'are'} signed in now.</p>
    </ConfirmDialog>
  );
  if (compact) return <><button type="button" className="jd-btn jd-btn-sm jd-killswitch" title={done ?? `${n} connector${n === 1 ? '' : 's'} signed in`} onClick={() => setAsking(true)}>{done ? 'Disconnected' : 'Disconnect agents'}</button>{dialog}</>;
  return (
    <p className="jd-muted">
      {done ?? `${n} connector${n === 1 ? '' : 's'} signed in.`}{' '}
      <button type="button" className="jd-btn jd-danger" onClick={() => setAsking(true)}>Disconnect every connector</button>
      {dialog}
    </p>
  );
}
