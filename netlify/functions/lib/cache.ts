/**
 * Blobs-backed stale-while-revalidate cache, replacing the disk-file +
 * background-daemon-thread pattern used by merkur_adapter.py, superbet_adapter.py,
 * stoiximan_adapter.py, and maxbet_adapter.py.
 *
 * Netlify Functions have no persistent process between invocations, so a
 * background thread has no equivalent. Instead:
 *   1. In-cache and fresh          -> return immediately.
 *   2. In-cache but stale          -> return the stale data immediately, and
 *                                     kick off a refresh via context.waitUntil()
 *                                     so the NEXT request sees fresh data
 *                                     without this request paying the fetch cost.
 *   3. No cache at all             -> block on a live fetch (first run only,
 *                                     same as the Python version).
 */
import { getStore } from "@netlify/blobs";
import type { Context } from "@netlify/functions";

interface CacheEnvelope<T> {
  fetchedAt: number;
  records: T;
}

export async function loadWithCache<T>(
  storeName: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
  context: Context
): Promise<T> {
  const store = getStore(storeName);

  let cached: CacheEnvelope<T> | null = null;
  try {
    cached = await store.get("data", { type: "json" });
  } catch (exc) {
    console.error(`[${storeName}] cache read failed:`, exc);
  }

  if (cached) {
    const ageMs = Date.now() - cached.fetchedAt;
    if (ageMs < ttlSeconds * 1000) {
      return cached.records;
    }

    // Stale — serve what we have, refresh in the background for next time.
    context.waitUntil(refreshAndStore(store, storeName, fetcher));
    return cached.records;
  }

  // No cache at all — block on a live fetch.
  const records = await fetcher();
  await writeCache(store, storeName, records);
  return records;
}

async function refreshAndStore<T>(
  store: ReturnType<typeof getStore>,
  storeName: string,
  fetcher: () => Promise<T>
): Promise<void> {
  try {
    const records = await fetcher();
    await writeCache(store, storeName, records);
    console.log(`[${storeName}] refreshed cache`);
  } catch (exc) {
    console.error(`[${storeName}] background refresh failed:`, exc);
  }
}

async function writeCache<T>(
  store: ReturnType<typeof getStore>,
  storeName: string,
  records: T
): Promise<void> {
  try {
    const envelope: CacheEnvelope<T> = { fetchedAt: Date.now(), records };
    await store.setJSON("data", envelope);
  } catch (exc) {
    console.error(`[${storeName}] cache write failed:`, exc);
  }
}
