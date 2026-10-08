import { useEffect, useRef, useState } from 'react';
import { actKey, TRIGGER, type Activity } from '../api';
import { stopReplay, usePoll, useReplay } from '../store';
import { Panel } from './Panel';

interface ActivityResponse { agent_mode: boolean; items: Activity[] }

// Newest first, polled every 5s. Rows that were not on the previous poll get a short highlight.
export function ActivityWidget() {
  const { data, error } = usePoll<ActivityResponse>('/api/activity', 5000);
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!data) return;
    const keys = data.items.map(actKey);
    if (seen.current) {
      const added = keys.filter((k) => !seen.current!.has(k));
      if (added.length) {
        setFresh(new Set(added));
        const t = setTimeout(() => setFresh(new Set()), 2500);
        seen.current = new Set(keys);
        return () => clearTimeout(t);
      }
    }
    seen.current = new Set(keys);
  }, [data]);

  const replay = useReplay();
  if (replay) {
    // Newest revealed step on top, like the live log; the newest one flashes as it appears.
    const shown = replay.entries.slice(0, replay.shown).reverse();
    const done = replay.shown >= replay.entries.length;
    return (
      <Panel title="Agent activity: replay" subtitle={`Logged events for ${replay.id}, ${new Date(replay.entries[0].at).toLocaleDateString()}${done ? '' : ', replaying...'}`}>
        <div className="jd-replay-bar">
          <span>Replay of what JUNCO actually did on this case. Nothing is sent to PayPal.</span>
          <button type="button" className="jd-btn" onClick={stopReplay}>{done ? 'Back to live' : 'Stop replay'}</button>
        </div>
        <ol className="jd-activity jd-activity-replay" aria-live="polite">
          {shown.map((x, i) => (
            <li key={actKey(x)} className={i === 0 && !done ? 'jd-new' : undefined}>
              <span className="jd-time">{new Date(x.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span className="jd-mono">{x.dispute_id}</span>
              <span className="jd-muted">{TRIGGER[x.trigger] ?? x.trigger}</span>
              <span><strong>{x.step}</strong>: {x.detail}</span>
            </li>
          ))}
        </ol>
      </Panel>
    );
  }

  const items = data?.items ?? [];
  return (
    <Panel
      title={data?.agent_mode ? 'Agent activity (agent mode on)' : 'Agent activity'}
      subtitle="Live from PayPal webhooks and scheduled checks"
      live
    >
      {error && <div className="jd-result jd-err">{error}</div>}
      <ol className="jd-activity" aria-live="polite">
        {items.length === 0 && <li className="jd-muted">Nothing yet.</li>}
        {items.map((x) => (
          <li key={actKey(x)} className={fresh.has(actKey(x)) ? 'jd-new' : undefined}>
            <span className="jd-time">{new Date(x.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <span className="jd-mono">{x.dispute_id}</span>
            <span className="jd-muted">{TRIGGER[x.trigger] ?? x.trigger}</span>
            <span><strong>{x.step}</strong>: {x.detail}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
