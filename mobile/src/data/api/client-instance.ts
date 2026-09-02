import { randomUUID } from "expo-crypto";

/**
 * This app launch's self-chosen id, stamped on every API request as
 * `X-Spawn-Client` and echoed back as `origin` on the data-changed frames a
 * mutation fans out (`server/spawn_server/data_events.py`).
 *
 * Per launch, matching the web's per-tab grain: the one reader is this
 * process recognising its own echo so an optimistic write is not raced by a
 * refetch of itself. Advisory routing only, never authorization, so nothing
 * needs to survive a restart.
 */
export const CLIENT_INSTANCE_ID: string = (() => {
  try {
    return randomUUID();
  } catch {
    return `app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
})();
