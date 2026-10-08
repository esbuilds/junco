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

// Replay: re-plays one case's logged agent activity in the activity widget, step by step, for judges.
// It only shows events that really happened (from the activity log); nothing is sent to PayPal.
export type Replay = { id: string; entries: import('./api').Activity[]; shown: number } | null;
let replay: Replay = null;
const replayListeners = new Set<() => void>();
const emitReplay = () => replayListeners.forEach((l) => l());
let timer: ReturnType<typeof setInterval> | undefined;
export function startReplay(id: string, entries: import('./api').Activity[]) {
  clearInterval(timer);
  const ordered = [...entries].sort((a, b) => a.at.localeCompare(b.at)); // oldest first, the order it happened
  replay = { id, entries: ordered, shown: 1 }; emitReplay();
  timer = setInterval(() => {
    if (!replay || replay.shown >= replay.entries.length) return clearInterval(timer);
    replay = { ...replay, shown: replay.shown + 1 }; emitReplay();
  }, 1800);
}
export function stopReplay() { clearInterval(timer); replay = null; emitReplay(); }
export const useReplay = (): Replay => useSyncExternalStore((cb) => { replayListeners.add(cb); return () => replayListeners.delete(cb); }, () => replay);
