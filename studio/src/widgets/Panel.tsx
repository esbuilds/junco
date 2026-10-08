import type { ReactNode } from 'react';

// Shared card chrome for the desk widgets, so every widget reads as one system.
export function Panel({ title, subtitle, live, children }: {
  title: string; subtitle?: string; live?: boolean; children: ReactNode;
}) {
  return (
    <section className="jd-panel">
      <header className="jd-panel-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <div className="jd-muted">{subtitle}</div>}
        </div>
        {live && <span className="jd-live" title="Updates every 5 seconds">live</span>}
      </header>
      <div className="jd-panel-body">{children}</div>
    </section>
  );
}
