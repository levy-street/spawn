import { useSessionUiStore } from "@/data/stores/session-ui";
import { terminalMetrics } from "@/theme";

describe("session UI store", () => {
  beforeEach(() => {
    useSessionUiStore.getState().clear();
  });

  it("creates per-session defaults while applying updates", () => {
    useSessionUiStore.getState().setFollow("session-1", false);
    expect(useSessionUiStore.getState().sessions["session-1"]).toEqual({
      follow: false,
      fontSize: terminalMetrics.fontSize,
      lastKnownTitle: null,
    });

    useSessionUiStore.getState().setFontSize("session-1", 17);
    useSessionUiStore.getState().setLastKnownTitle("session-1", "Build");
    expect(useSessionUiStore.getState().sessions["session-1"]).toMatchObject({
      fontSize: 17,
      lastKnownTitle: "Build",
    });
  });

  it("ignores invalid font sizes and cleans closed sessions", () => {
    useSessionUiStore.getState().setFontSize("session-1", Number.NaN);
    expect(useSessionUiStore.getState().sessions["session-1"]).toBeUndefined();
    useSessionUiStore.getState().setFollow("session-1", true);
    useSessionUiStore.getState().cleanup("session-1");
    expect(useSessionUiStore.getState().sessions["session-1"]).toBeUndefined();
  });
});
