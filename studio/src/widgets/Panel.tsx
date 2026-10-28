import type { ReactNode } from 'react';

// Shared card chrome for the desk widgets, so every widget reads as one system.
// hug: the card ends with its content (the one-panel pages) instead of filling its grid cell.
// live: a quiet "Live" label (no pill, no pulse). action: a link or button on the right of the header (View all).
export function Panel({ id, title, subtitle, live, action, hug, children }: {
  id?: string; title: string; subtitle?: string; live?: boolean; action?: ReactNode; hug?: boolean; children: ReactNode;
}) {
  return (
    <section className={hug ? 'jd-panel jd-panel-hug' : 'jd-panel'} id={id}>
      <header className="jd-panel-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <div className="jd-muted">{subtitle}</div>}
        </div>
        {action}
        {live && <span className="jd-live" title="Updates every 5 seconds">Live</span>}
      </header>
      <div className="jd-panel-body">{children}</div>
    </section>
  );
}
