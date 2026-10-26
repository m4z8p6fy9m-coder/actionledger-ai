import { useEffect, useState } from "react";
import { api, type ActionPage } from "../api";
export type ActionFilters = {
  q?: string;
  status?: string;
  sort?: string;
  offset?: number;
  limit?: number;
};
export function actionQuery(filters: ActionFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (
      value !== undefined &&
      value !== "" &&
      !(key === "status" && value === "ALL")
    )
      params.set(key, String(value));
  return params.toString();
}
export function useActionPage(filters: ActionFilters, revision: number | null) {
  const key = actionQuery(filters);
  const [result, setResult] = useState<{
    key: string;
    page: ActionPage;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api<ActionPage>("/action-page?" + key, undefined, {
      signal: controller.signal,
    })
      .then((page) => {
        if (!controller.signal.aborted) setResult({ key, page });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "The ledger could not be loaded.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [key, revision, retry]);
  return {
    page: result?.key === key ? result.page : null,
    loading,
    error,
    retry: () => setRetry((n) => n + 1),
  };
}
export function useDebouncedValue(value: string, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
