import { heatmapColumns, heatmapWindow, weekdayIndex } from "@/components/settings/profile-screen";

function day(iso: string, sessions = 0) {
  return {
    day: iso,
    sessions_started: sessions,
    session_seconds: 0,
    peak_sessions: 0,
    peak_hosts_online: 0,
  };
}

describe("profile heatmap", () => {
  it("counts weekdays from Monday", () => {
    // 2024-01-01 was a Monday.
    expect(weekdayIndex("2024-01-01")).toBe(0);
    expect(weekdayIndex("2024-01-03")).toBe(2);
    expect(weekdayIndex("2024-01-07")).toBe(6);
  });

  it("lays the days out one week per column, starting on their weekday", () => {
    // Ten days from a Wednesday: two empty cells above the first, and the last
    // column padded to a full week so every column stands the same height.
    const days = Array.from({ length: 10 }, (_, index) =>
      day(`2024-01-${String(3 + index).padStart(2, "0")}`, index),
    );
    const columns = heatmapColumns(days);

    expect(columns).toHaveLength(2);
    expect(columns[0]?.map((cell) => cell?.day ?? null)).toEqual([
      null,
      null,
      "2024-01-03",
      "2024-01-04",
      "2024-01-05",
      "2024-01-06",
      "2024-01-07",
    ]);
    expect(columns[1]?.map((cell) => cell?.day ?? null)).toEqual([
      "2024-01-08",
      "2024-01-09",
      "2024-01-10",
      "2024-01-11",
      "2024-01-12",
      null,
      null,
    ]);
  });

  it("draws nothing for no days", () => {
    expect(heatmapColumns([])).toEqual([]);
  });

  it("fills the whole window with quiet days around the ones the server sent", () => {
    // The server sends only the days that had sessions; a heatmap built from
    // those alone was two cells wide on a new account.
    const window = heatmapWindow([day("2024-01-09", 3), day("2024-01-10", 1)], "2024-01-10", 10);
    expect(window.map((entry) => entry.day)).toEqual([
      "2024-01-01",
      "2024-01-02",
      "2024-01-03",
      "2024-01-04",
      "2024-01-05",
      "2024-01-06",
      "2024-01-07",
      "2024-01-08",
      "2024-01-09",
      "2024-01-10",
    ]);
    expect(window.map((entry) => entry.sessions_started)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 3, 1]);
    expect(heatmapColumns(window)).toHaveLength(2);
  });
});
