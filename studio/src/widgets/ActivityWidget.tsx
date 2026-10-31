import { useEffect, useRef, useState } from 'react';
import { actKey, TRIGGER, type Activity } from '../api';
import { usePoll } from '../store';
import { recentView } from '../ui';
import { Clip } from './Clip';
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

  const [all, setAll] = useState(false), [red, setRed] = useState(false);
  // The red team's attempts and its attacker's prose sit behind their own toggle; the feed is the store's work.
  const { kept: items, shown, tests: redRows } = recentView(data?.items ?? [], (x) => x.trigger === 'red team', { tests: red, all, n: 4 }); // the rail never scrolls inside; View all expands it
  return (
    <Panel
      title="Agent activity"
      subtitle={data?.agent_mode ? 'Agent mode on' : undefined}
      live
      action={items.length > 4 ? <button type="button" className="jd-linkish jd-muted" onClick={() => setAll(!all)}>{all ? 'Show fewer' : 'View all'}</button> : undefined}
    >
      {error && <div className="jd-result jd-err">{error}</div>}
      <ol className="jd-feed" aria-live="polite">
        {items.length === 0 && <li className="jd-muted">Nothing yet.</li>}
        {shown.map((x) => (
          <li key={actKey(x)} className={fresh.has(actKey(x)) ? 'jd-new' : undefined}>
            <div className="jd-feed-meta"><span className="jd-id">{new Date(x.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> · {TRIGGER[x.trigger] ?? x.trigger}{/\d/.test(x.dispute_id ?? '') && <> · <span className="jd-id">{x.dispute_id}</span></>}</div>
            <div className="jd-feed-text"><strong>{x.step.replace(/^./, (c) => c.toUpperCase())}</strong>: <Clip text={x.detail} /></div>
          </li>
        ))}
      </ol>
      {redRows > 0 && <button type="button" className="jd-linkish jd-muted jd-more" onClick={() => setRed(!red)}>{red ? 'Hide red team' : `Show ${redRows} red team entr${redRows === 1 ? 'y' : 'ies'}`}</button>}
    </Panel>
  );
}
