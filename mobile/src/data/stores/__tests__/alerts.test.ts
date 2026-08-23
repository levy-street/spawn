import type { AlertEvent } from "@/data/realtime/alert-socket";
import { ALERT_DEDUP_TTL_MS, alertEventKey, useAlertStore } from "@/data/stores/alerts";

const ALERT: AlertEvent = {
  event: "agent.finished",
  session_id: "session-1",
  command: "codex",
  exit_code: null,
  signal: null,
  at: "2026-08-22T03:12:01Z",
};

describe("alert store", () => {
  beforeEach(() => {
    useAlertStore.getState().clear();
  });

  it("deduplicates event keys within the bounded TTL", () => {
    expect(useAlertStore.getState().receive(ALERT, 1_000)).toBe(true);
    expect(useAlertStore.getState().receive(ALERT, 1_001)).toBe(false);
    expect(useAlertStore.getState().alerts).toHaveLength(1);

    expect(useAlertStore.getState().receive(ALERT, 1_000 + ALERT_DEDUP_TTL_MS)).toBe(true);
    expect(useAlertStore.getState().alerts).toHaveLength(2);
  });

  it("claims each key once per TTL without implying acknowledgement", () => {
    const key = alertEventKey(ALERT);
    expect(useAlertStore.getState().claim(key, 1_000)).toBe(true);
    expect(useAlertStore.getState().claim(key, 2_000)).toBe(false);
    expect(useAlertStore.getState().claim(key, 1_000 + ALERT_DEDUP_TTL_MS)).toBe(true);
  });

  it("removes alerts by key or session and clears transient state", () => {
    const second = { ...ALERT, session_id: "session-2" };
    useAlertStore.getState().receive(ALERT, 1_000);
    useAlertStore.getState().receive(second, 1_000);
    useAlertStore.getState().remove(alertEventKey(ALERT));
    expect(useAlertStore.getState().alerts.map((item) => item.alert.session_id)).toEqual([
      "session-2",
    ]);

    useAlertStore.getState().removeSession("session-2");
    expect(useAlertStore.getState().alerts).toEqual([]);
    useAlertStore.getState().clear();
    expect(useAlertStore.getState().seenKeys).toEqual({});
  });
});
