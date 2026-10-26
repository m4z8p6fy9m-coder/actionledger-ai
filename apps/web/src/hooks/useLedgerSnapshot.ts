import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Snapshot } from "../api";

/** Keep the last good snapshot, cancel superseded reads, and never overlap background polls. */
export function useLedgerSnapshot() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    const current = ++generation.current;
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    pending.current = true;
    setRefreshing(true);
    try {
      const snapshot = await api<Snapshot>("/state", undefined, {
        signal: next.signal,
      });
      if (!mounted.current || current !== generation.current) return;
      setData(snapshot);
      setLastUpdated(Date.now());
      setError(null);
    } catch (error) {
      if (
        mounted.current &&
        current === generation.current &&
        !next.signal.aborted
      )
        setError(
          error instanceof Error
            ? error.message
            : "Cannot reach the local API.",
        );
    } finally {
      if (mounted.current && current === generation.current) {
        pending.current = false;
        setRefreshing(false);
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const poll = () => {
      if (!document.hidden && !pending.current) void refresh();
    };
    const interval = setInterval(poll, 3000);
    document.addEventListener("visibilitychange", poll);
    window.addEventListener("online", poll);
    return () => {
      mounted.current = false;
      ++generation.current;
      controller.current?.abort();
      pending.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
      window.removeEventListener("online", poll);
    };
  }, [refresh]);
  const connection = error
    ? "Disconnected"
    : !data
      ? "Connecting"
      : data.providerError
        ? "Provider offline"
        : "Connected";
  return { data, error, lastUpdated, refreshing, connection, refresh };
}
