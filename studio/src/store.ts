// Shared desk state across widgets: which case is open. Widgets talk through this, not through Studio's data engine.
import { useSyncExternalStore } from 'react';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

let selected: string | null = null;
const listeners = new Set<() => void>();

export function selectCase(id: string | null) {
  selected = id;
  listeners.forEach((l) => l());
}

export function useSelectedCase(): string | null {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => selected,
  );
}

// Polls a desk GET endpoint. Pauses while the tab is hidden; `tick` forces an immediate reload.
export function usePoll<T>(path: string | null, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!path) return;
    const load = () => {
      if (document.hidden) return;
      api<T>(path).then((d) => { if (alive.current) { setData(d); setError(null); } })
        .catch((e) => { if (alive.current) setError(e.message); });
    };
    load();
    const t = setInterval(load, ms);
    return () => { alive.current = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ms, tick, ...deps]);
  return { data, error, reload: () => setTick((n) => n + 1) };
}
