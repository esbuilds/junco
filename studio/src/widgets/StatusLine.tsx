import { usePoll } from '../store';
import { checkWords } from '../ui';

// v3.14 item 3: the desk's health in one line, from the server's 30-minute self-check. A paused AI says the desk is
// read-only (browsing, saved recommendations, holds and past runs still work) instead of failing on the next click.
type Status = { check: { at: string; failed: string[]; checks: Record<string, string> } | null; ai_paused: string | null; owner?: boolean };

export function StatusLine() {
  const { data } = usePoll<Status>('/api/status', 60000);
  if (!data) return null;
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const [cls, text] = data.ai_paused ? ['paused', `Read-only: the AI is paused (${data.ai_paused})`]
    // A failing check is the owner's news but rarely the owner's to fix (PayPal's hosted server down): a quiet line, the
    // names and times on hover. Red stays for things the owner must act on.
    : data.check?.failed.length ? ['degraded', checkWords(data.check.failed)]
    : data.check ? ['ok', `All systems live as of ${time(data.check.at)}`]
    : data.owner ? ['ok', 'Self-check runs a minute after start'] : [];
  if (!text) return null; // visitors see the chip only when the AI is paused; the self-check is the owner's
  const detail = data.check ? [`Self-check ${time(data.check.at)}${data.check.failed.length ? `: ${data.check.failed.join(', ')} failing` : ''}`, ...Object.entries(data.check.checks).map(([k, v]) => `${k}: ${v}`)].join('\n') : undefined;
  return <span className={`jd-status jd-status-${cls}`} title={detail} aria-live="polite">{text}</span>;
}
