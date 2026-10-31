import { usePoll, useReplay, useSelectedCase } from '../store';

// D2: always say whether what's on screen is live from PayPal's sandbox, a recorded replay, or a simulation, and which case.
type Mine = { mine: { dispute_id: string; lease_until: string; yours: boolean } | null };

export function CaseBanner({ page }: { page: string }) {
  const id = useSelectedCase(), replay = useReplay();
  const { data } = usePoll<Mine>('/api/store-dispute', 15000);
  const lease = data?.mine?.yours && data.mine.dispute_id === id && Date.parse(data.mine.lease_until) > Date.now() ? data.mine.lease_until : null;
  const [kind, text] = replay ? ['RECORDED', `${replay.id} · a replay of JUNCO's own log`]
    : page === 'try' ? ['SIMULATED', 'synthetic cases · nothing reaches PayPal']
    : page === 'mandate' ? ['LIVE', "simulated buyer · real seller side on PayPal's sandbox"]
    : id ? ['LIVE', `${id} · PayPal's sandbox${lease ? ` · yours until ${new Date(lease).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`]
    : ['LIVE', "PayPal's sandbox"];
  // A dot whose shape says which: solid LIVE, hollow RECORDED, dashed SIMULATED, so they never look alike.
  const word = kind[0] + kind.slice(1).toLowerCase();
  return <span className={`jd-env jd-env-${kind.toLowerCase()}`} title={`${kind}: ${text}`} aria-live="polite"><i aria-hidden="true" /><span className="jd-env-text"><strong>{word}</strong> · {text}</span></span>;
}
