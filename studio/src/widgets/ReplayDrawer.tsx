import { actKey, TRIGGER } from '../api';
import { stopReplay, useReplay } from '../store';

// Judge replay in its own drawer (outside Studio) so the log has room: one case's real activity, step by step.
export function ReplayDrawer() {
  const replay = useReplay();
  if (!replay) return null;
  const shown = replay.entries.slice(0, replay.shown).reverse();
  const done = replay.shown >= replay.entries.length;
  return (
    <aside className="jd-drawer" role="dialog" aria-label="Replay of what JUNCO did">
      <div className="jd-start-head"><strong>Replay: {replay.id}</strong>
        <button type="button" className="jd-btn" onClick={stopReplay}>{done ? 'Close' : 'Stop'}</button></div>
      <p className="jd-replay-bar">What JUNCO actually did on this case, step by step from its log{done ? '' : ' (replaying)'}. Nothing is sent to PayPal.</p>
      <ol className="jd-drawer-list" aria-live="polite">
        {shown.map((x, i) => (
          <li key={actKey(x)} className={i === 0 && !done ? 'jd-new' : undefined}>
            <span className="jd-time">{new Date(x.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {TRIGGER[x.trigger] ?? x.trigger}</span>
            <span><strong>{x.step}</strong>: {x.detail}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}
