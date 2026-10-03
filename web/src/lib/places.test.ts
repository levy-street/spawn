import { expect, test } from "bun:test";
import type { Host, Session } from "./api";
import { displayPath, suggestPlaces } from "./places";

function host(id: string, status: Host["status"] = "online"): Host {
  return { id, name: id, status } as Host;
}

function session(id: string, hostId: string, cwd: string, usedAt: string): Session {
  return {
    id,
    host_id: hostId,
    cwd,
    started_at: usedAt,
    last_input_at: usedAt,
    last_activity_at: null,
  } as Session;
}

const hosts = [host("dream"), host("pallete"), host("alto", "offline")];
const sessions = [
  session("focus", "dream", "/home/oem/projects/spawn", "2026-10-01T10:00:00Z"),
  session("tabmate", "pallete", "/Users/oem/site", "2026-10-01T09:00:00Z"),
  session("old", "dream", "/home/oem/notes", "2026-09-01T09:00:00Z"),
  session("new", "dream", "/home/oem/lab", "2026-10-01T11:00:00Z"),
  session("away", "alto", "C:/Users/oem/work", "2026-10-01T12:00:00Z"),
];

test("the focused pane's place leads, then its tab, then recent, then homes", () => {
  const ranked = suggestPlaces({
    sessions,
    hosts,
    focusedSessionId: "focus",
    tabSessionIds: ["focus", "tabmate"],
    limit: 20,
  });
  expect(ranked.map((place) => `${place.reason}:${place.hostId}:${place.cwd}`)).toEqual([
    "focused:dream:/home/oem/projects/spawn",
    "tab:pallete:/Users/oem/site",
    "recent:dream:/home/oem/lab",
    "recent:dream:/home/oem/notes",
    "home:dream:~",
    "home:pallete:~",
    // An offline host is listed, after everything a window can open in.
    "recent:alto:C:/Users/oem/work",
    "home:alto:~",
  ]);
});

test("a place appears once, under its strongest reason, and an excluded place not at all", () => {
  const ranked = suggestPlaces({
    sessions: [...sessions, session("twin", "dream", "/home/oem/projects/spawn", "2026-10-02")],
    hosts,
    focusedSessionId: "focus",
    exclude: { hostId: "pallete", cwd: "/Users/oem/site" },
    limit: 20,
  });
  const spawn = ranked.filter((place) => place.cwd === "/home/oem/projects/spawn");
  expect(spawn).toHaveLength(1);
  expect(spawn[0].reason).toBe("focused");
  expect(ranked.some((place) => place.cwd === "/Users/oem/site")).toBe(false);
});

test("without any windows the default is a reachable host's home", () => {
  const [first] = suggestPlaces({ sessions: [], hosts });
  expect(first).toEqual({ hostId: "dream", cwd: "~", reason: "home", online: true });
});

test("home directories read as ~", () => {
  expect(displayPath("/home/oem/projects/spawn")).toBe("~/projects/spawn");
  expect(displayPath("/Users/max/site")).toBe("~/site");
  expect(displayPath("C:\\Users\\max\\work")).toBe("~/work");
  expect(displayPath("/root")).toBe("~");
  expect(displayPath("/srv/data")).toBe("/srv/data");
});
