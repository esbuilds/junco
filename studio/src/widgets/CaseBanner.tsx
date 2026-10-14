import { usePoll, useReplay, useSelectedCase } from '../store';

// D2: always say whether what's on screen is live from PayPal's sandbox, a recorded replay, or a simulation, and which case.
type Mine = { mine: { dispute_id: string; lease_until: string; yours: boolean } | null };

export function CaseBanner({ page }: { page: string }) {
  const id = useSelectedCase(), replay = useReplay();
  const { data } = usePoll<Mine>('/api/store-dispute', 15000);
  const lease = data?.mine?.yours && data.mine.dispute_id === id && Date.parse(data.mine.lease_until) > Date.now() ? data.mine.lease_until : null;
  const [kind, text] = replay ? ['RECORDED', `${replay.id} · a replay of JUNCO's own log`]
    : page === 'try' ? ['SIMULATED', 'synthetic cases · nothing reaches PayPal']
    : page === 'mandate' ? ['LIVE', "simulated buyer · the seller side is real on PayPal's sandbox"]
    : id ? ['LIVE', `${id} · read from PayPal's sandbox now${lease ? ` · yours until ${new Date(lease).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`]
    : ['LIVE', "PayPal's sandbox"];
  return <span className={`jd-tag jd-tag-${kind.toLowerCase()}`} title={`${kind}: ${text}`} aria-live="polite"><strong>{kind}</strong> {text}</span>;
}
