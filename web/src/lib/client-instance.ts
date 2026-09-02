/**
 * This tab's self-chosen id, stamped on every API request as `X-Spawn-Client`
 * and echoed back as `origin` on the data-changed frames the mutation fans
 * out (`server/spawn_server/data_events.py`).
 *
 * Per *tab*, deliberately: two tabs on one device must still update each
 * other, so a device-wide identity would be the wrong grain. The one reader
 * is the tab itself recognising its own echo — advisory routing in the
 * `PushDevice.browser_device_id` tradition, never authorization — so a
 * module-level random suffices and nothing needs to survive a reload.
 */

function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Insecure contexts and very old runtimes: a weaker id only weakens the
    // echo skip, never anything trusted.
    return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export const CLIENT_INSTANCE_ID = makeId();
