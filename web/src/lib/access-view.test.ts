import { describe, expect, test } from "bun:test";
import {
  type AccessDevice,
  type AccessViewInput,
  deriveDeviceVMs,
  deriveHostVMs,
  deriveTrustEvents,
  seenLabel,
  shortDate,
} from "./access-view";

const NOW = new Date("2026-08-20T12:00:00Z");

function device(over: Partial<AccessDevice> & { id: string }): AccessDevice {
  return {
    label: null,
    created_at: "2026-06-01T00:00:00Z",
    last_seen_at: null,
    revoked_at: null,
    revoked_by_device_id: null,
    is_root: false,
    ...over,
  };
}

function input(over: Partial<AccessViewInput>): AccessViewInput {
  return {
    devices: [],
    edges: [],
    hosts: [],
    pinDetails: new Map(),
    passkeys: [],
    currentDeviceId: null,
    ...over,
  };
}

describe("formatting", () => {
  test("shortDate omits the current year, includes other years", () => {
    expect(shortDate("2026-06-03T10:00:00Z", NOW)).toBe("Jun 3");
    expect(shortDate("2025-06-03T10:00:00Z", NOW)).toBe("Jun 3, 2025");
  });

  test("seenLabel scales from Now to a date", () => {
    expect(seenLabel("2026-08-20T11:59:30Z", NOW)).toBe("Now");
    expect(seenLabel("2026-08-20T11:48:00Z", NOW)).toBe("12m ago");
    expect(seenLabel("2026-08-20T09:00:00Z", NOW)).toBe("3h ago");
    expect(seenLabel("2026-08-12T09:00:00Z", NOW)).toBe("Aug 12");
    expect(seenLabel(null, NOW)).toBe("—");
  });
});

describe("device rows", () => {
  const mac = device({ id: "mac", label: "MacBook Pro", created_at: "2026-05-01T00:00:00Z" });
  const phone = device({ id: "phone", label: "iPhone", created_at: "2026-06-03T00:00:00Z" });
  const root = device({ id: "root", label: null, is_root: true });

  test("the earliest live device is First device; the root never appears", () => {
    const vms = deriveDeviceVMs(input({ devices: [phone, mac, root] }), NOW);
    expect(vms.map((v) => v.id)).not.toContain("root");
    expect(vms.find((v) => v.id === "mac")?.provenance).toBe("First device");
  });

  test("an inbound device edge reads Approved by; a root edge reads passkey", () => {
    const pixel = device({ id: "pixel", label: "Pixel 9", created_at: "2026-07-02T00:00:00Z" });
    const vms = deriveDeviceVMs(
      input({
        devices: [mac, phone, pixel, root],
        edges: [
          {
            endorser_device_id: "mac",
            endorsed_device_id: "phone",
            created_at: "2026-06-03T08:00:00Z",
          },
          {
            endorser_device_id: "root",
            endorsed_device_id: "pixel",
            created_at: "2026-07-02T08:00:00Z",
          },
          // A later retrofit heal must not rewrite the phone's provenance.
          {
            endorser_device_id: "root",
            endorsed_device_id: "phone",
            created_at: "2026-08-01T00:00:00Z",
          },
        ],
      }),
      NOW,
    );
    expect(vms.find((v) => v.id === "phone")?.provenance).toBe("Approved by MacBook Pro · Jun 3");
    expect(vms.find((v) => v.id === "pixel")?.provenance).toBe("Signed in with passkey · Jul 2");
    expect(vms.find((v) => v.id === "pixel")?.kind).toBe("phone");
  });

  test("no edge and no pin means waiting; a pinned pre-mesh device is not", () => {
    const fresh = device({
      id: "fresh",
      label: "Firefox on Mac",
      created_at: "2026-08-20T11:58:30Z",
    });
    const legacy = device({ id: "old", label: "Old Mac", created_at: "2026-06-10T00:00:00Z" });
    const vms = deriveDeviceVMs(
      input({
        devices: [mac, fresh, legacy],
        pinDetails: new Map([
          ["h1", [{ device_id: "old", direct: false, created_at: "2026-06-11T00:00:00Z" }]],
        ]),
      }),
      NOW,
    );
    const waiting = vms.find((v) => v.id === "fresh");
    expect(waiting?.waiting).toBe(true);
    expect(waiting?.provenance).toBe("Signed in 1 minute ago");
    expect(vms.find((v) => v.id === "old")?.provenance).toBe("Trusted since Jun 11");
    // Waiting rows sort ahead of settled ones (after this-device).
    expect(vms[0]?.id).toBe("fresh");
  });

  test("this device sorts first and is flagged", () => {
    const vms = deriveDeviceVMs(input({ devices: [mac, phone], currentDeviceId: "phone" }), NOW);
    expect(vms[0]?.id).toBe("phone");
    expect(vms[0]?.isThisDevice).toBe(true);
  });
});

describe("host rows", () => {
  test("provenance names the earliest direct pin; online tracks status", () => {
    const vms = deriveHostVMs(
      input({
        devices: [device({ id: "mac", label: "MacBook Pro" })],
        hosts: [
          { id: "h1", name: "mac-studio", status: "online" },
          { id: "h2", name: "dev-box", status: "offline" },
        ],
        pinDetails: new Map([
          [
            "h1",
            [
              { device_id: "mac", direct: true, created_at: "2026-05-28T00:00:00Z" },
              { device_id: "other", direct: false, created_at: "2026-05-01T00:00:00Z" },
            ],
          ],
        ]),
      }),
      NOW,
    );
    expect(vms.find((v) => v.id === "h1")?.provenance).toBe("Possessed by MacBook Pro · May 28");
    expect(vms.find((v) => v.id === "h1")?.online).toBe(true);
    expect(vms.find((v) => v.id === "h2")?.provenance).toBe("");
    expect(vms.find((v) => v.id === "h2")?.online).toBe(false);
  });
});

describe("trust history", () => {
  test("composes approvals, passkey sign-ins, possessions, removals, passkeys — newest first", () => {
    const events = deriveTrustEvents(
      input({
        devices: [
          device({ id: "mac", label: "MacBook Pro", created_at: "2026-05-01T00:00:00Z" }),
          device({ id: "phone", label: "iPhone" }),
          device({ id: "pixel", label: "Pixel 9" }),
          device({
            id: "ipad",
            label: "Old iPad",
            revoked_at: "2026-08-19T00:00:00Z",
            revoked_by_device_id: "mac",
          }),
          device({ id: "root", is_root: true }),
        ],
        edges: [
          {
            endorser_device_id: "mac",
            endorsed_device_id: "phone",
            created_at: "2026-06-03T00:00:00Z",
          },
          {
            endorser_device_id: "root",
            endorsed_device_id: "pixel",
            created_at: "2026-07-02T00:00:00Z",
          },
        ],
        hosts: [{ id: "h1", name: "mac-studio", status: "online" }],
        pinDetails: new Map([
          ["h1", [{ device_id: "mac", direct: true, created_at: "2026-05-28T00:00:00Z" }]],
        ]),
        passkeys: [{ id: "pk1", created_at: "2026-04-02T00:00:00Z" }],
      }),
      NOW,
    );
    expect(events.map((e) => e.text)).toEqual([
      "Old iPad removed by MacBook Pro",
      "Pixel 9 signed in with passkey",
      "MacBook Pro approved iPhone",
      "MacBook Pro possessed mac-studio",
      "Passkey added",
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      "removed",
      "passkey",
      "approved",
      "approved",
      "passkey",
    ]);
    expect(events[0]?.when).toBe("Aug 19");
  });

  test("a mutual endorsement is one approval line, not two", () => {
    const events = deriveTrustEvents(
      input({
        devices: [
          device({ id: "mac", label: "MacBook Pro", created_at: "2026-05-01T00:00:00Z" }),
          device({ id: "phone", label: "iPhone" }),
        ],
        edges: [
          {
            endorser_device_id: "mac",
            endorsed_device_id: "phone",
            created_at: "2026-06-03T00:00:00Z",
          },
          // The new device's automatic reciprocal, seconds later.
          {
            endorser_device_id: "phone",
            endorsed_device_id: "mac",
            created_at: "2026-06-03T00:00:09Z",
          },
        ],
      }),
      NOW,
    );
    expect(events.map((e) => e.text)).toEqual(["MacBook Pro approved iPhone"]);
  });

  test("a removal by an unknown device stays unattributed", () => {
    const events = deriveTrustEvents(
      input({
        devices: [device({ id: "gone", label: "Gone", revoked_at: "2026-08-01T00:00:00Z" })],
      }),
      NOW,
    );
    expect(events[0]?.text).toBe("Gone removed");
  });
});
