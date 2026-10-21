import { usePoll } from '../store';

// v3.14 item 3: the desk's health in one line, from the server's 30-minute self-check. A paused AI says the desk is
// read-only (browsing, saved recommendations, holds and past runs still work) instead of failing on the next click.
type Status = { check: { at: string; failed: string[]; checks: Record<string, string> } | null; ai_paused: string | null; owner?: boolean };

export function StatusLine() {
  const { data } = usePoll<Status>('/api/status', 60000);
  if (!data) return null;
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const [cls, text] = data.ai_paused ? ['warn', `Read-only: the AI is paused (${data.ai_paused})`]
    : data.check?.failed.length ? ['warn', `Self-check ${time(data.check.at)}: ${data.check.failed.join(', ')} failing`]
    : data.check ? ['ok', `All systems live as of ${time(data.check.at)}`]
    : data.owner ? ['ok', 'Self-check runs a minute after start'] : [];
  if (!text) return null; // visitors see the chip only when the AI is paused; the self-check is the owner's
  const detail = data.check ? Object.entries(data.check.checks).map(([k, v]) => `${k}: ${v}`).join('\n') : undefined;
  return <span className={`jd-status jd-status-${cls}`} title={detail} aria-live="polite">{text}</span>;
}
