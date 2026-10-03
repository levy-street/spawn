import { displayPath, suggestPlaces } from "@/data/selectors/places";

const hosts = [
  { id: "dream", status: "online" },
  { id: "pallete", status: "online" },
  { id: "alto", status: "offline" },
];

function session(id: string, host_id: string, cwd: string, usedAt: string) {
  return { id, host_id, cwd, started_at: usedAt, last_input_at: usedAt, last_activity_at: null };
}

const sessions = [
  session("tabmate", "pallete", "/Users/oem/site", "2026-10-01T09:00:00Z"),
  session("old", "dream", "/home/oem/notes", "2026-09-01T09:00:00Z"),
  session("new", "dream", "/home/oem/lab", "2026-10-01T11:00:00Z"),
  session("away", "alto", "C:/Users/oem/work", "2026-10-01T12:00:00Z"),
];

describe("suggestPlaces", () => {
  it("ranks this tab, then recent places, then each host's home, offline last", () => {
    const ranked = suggestPlaces({ sessions, hosts, tabSessionIds: ["tabmate"], limit: 20 });
    expect(ranked.map((place) => `${place.reason}:${place.hostId}:${place.cwd}`)).toEqual([
      "tab:pallete:/Users/oem/site",
      "recent:dream:/home/oem/lab",
      "recent:dream:/home/oem/notes",
      "home:dream:~",
      "home:pallete:~",
      "recent:alto:C:/Users/oem/work",
      "home:alto:~",
    ]);
  });

  it("leaves out an excluded place and offers a reachable home when nothing ran yet", () => {
    expect(
      suggestPlaces({
        sessions,
        hosts,
        exclude: { hostId: "pallete", cwd: "/Users/oem/site" },
      }).some((place) => place.cwd === "/Users/oem/site"),
    ).toBe(false);
    expect(suggestPlaces({ sessions: [], hosts })[0]).toEqual({
      hostId: "dream",
      cwd: "~",
      reason: "home",
      online: true,
    });
  });

  it("reads home directories as ~", () => {
    expect(displayPath("/home/oem/projects/spawn")).toBe("~/projects/spawn");
    expect(displayPath("C:\\Users\\max\\work")).toBe("~/work");
    expect(displayPath("/srv/data")).toBe("/srv/data");
  });
});
