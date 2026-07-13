import { useQuery, usePollingQuery } from "../../apiHooks";

interface IntervalFetchState<T> {
  data: T | null;
  error: string | null;
  reload: () => void;
}

export function useIntervalFetch<T>(key: string | null, fetch: () => Promise<T>, ms: number | null): IntervalFetchState<T> {
  const oneShot = useQuery<T>(ms === null ? key : null, fetch);
  const polling = usePollingQuery<T>(ms === null ? null : key, fetch, ms ?? 0);
  return ms === null
    ? { data: oneShot.data, error: oneShot.error, reload: oneShot.reload }
    : { data: polling.data, error: polling.error, reload: polling.reload };
}
