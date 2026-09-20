import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** Seed a detail query from a fresh list that already supplied its navigation.
 * Keep the list's timestamp: opening a detail must not renew stale metadata.
 * This is metadata only; the shared transport still verifies host identity and
 * the daemon still authorizes the session attachment and input control. */
export function cachedListItem<T extends { id: string }>(
  client: QueryClient,
  queryKey: QueryKey,
  id: string,
  maxAgeMs = 30_000,
): { initialData?: T; initialDataUpdatedAt?: number } {
  const oldest = Date.now() - maxAgeMs;
  let initialData: T | undefined;
  let initialDataUpdatedAt = 0;
  for (const query of client.getQueryCache().findAll({ queryKey })) {
    const { data, dataUpdatedAt, isInvalidated } = query.state;
    if (
      isInvalidated ||
      dataUpdatedAt < oldest ||
      dataUpdatedAt <= initialDataUpdatedAt ||
      !Array.isArray(data)
    )
      continue;
    const item = data.find((value: T) => value?.id === id);
    if (item) {
      initialData = item;
      initialDataUpdatedAt = dataUpdatedAt;
    }
  }
  return initialData ? { initialData, initialDataUpdatedAt } : {};
}
