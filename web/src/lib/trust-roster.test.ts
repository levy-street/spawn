import { describe, expect, test } from "bun:test";
import { computeTrustRoster, hostsSolelyTrustedBy } from "./trust-roster";

const device = (id: string, opts: { revoked?: boolean; isRoot?: boolean } = {}) => ({
  id,
  revoked_at: opts.revoked ? "2026-08-20T00:00:00Z" : null,
  is_root: opts.isRoot ?? false,
});

const edge = (endorser: string, endorsed: string) => ({
  endorser_device_id: endorser,
  endorsed_device_id: endorsed,
});

describe("computeTrustRoster", () => {
  test("chains from pinned anchors and the root; provenance lists live vouchers", () => {
    const devices = [
      device("root", { isRoot: true }),
      device("laptop"), // pinned anchor
      device("phone"), // chained via laptop
      device("tablet"), // root-child
      device("stray"), // no edges at all
    ];
    const edges = [edge("laptop", "phone"), edge("root", "tablet")];
    const roster = computeTrustRoster(devices, edges, new Set(["laptop"]));

    expect(roster.get("laptop")).toEqual({
      vouchedForBy: [],
      chainTrusted: true,
      rootChild: false,
    });
    expect(roster.get("phone")).toEqual({
      vouchedForBy: ["laptop"],
      chainTrusted: true,
      rootChild: false,
    });
    expect(roster.get("tablet")).toEqual({
      vouchedForBy: ["root"],
      chainTrusted: true,
      rootChild: true,
    });
    expect(roster.get("stray")).toEqual({
      vouchedForBy: [],
      chainTrusted: false,
      rootChild: false,
    });
  });

  test("edges from a revoked device grant nothing — the subtree goes dark", () => {
    // Mirrors the daemon's RevocationSet subtraction: revoking mid severs leaf
    // even though leaf itself is unrevoked.
    const devices = [device("anchor"), device("mid", { revoked: true }), device("leaf")];
    const edges = [edge("anchor", "mid"), edge("mid", "leaf")];
    const roster = computeTrustRoster(devices, edges, new Set(["anchor"]));
    expect(roster.get("leaf")?.chainTrusted).toBe(false);
    expect(roster.get("leaf")?.vouchedForBy).toEqual([]);
  });

  test("a revoked root neither anchors nor makes root-children", () => {
    const devices = [device("root", { isRoot: true, revoked: true }), device("orphan")];
    const roster = computeTrustRoster(devices, [edge("root", "orphan")], new Set());
    expect(roster.get("orphan")).toEqual({
      vouchedForBy: [],
      chainTrusted: false,
      rootChild: false,
    });
  });

  test("multi-hop chains resolve (anchor → a → b → c)", () => {
    const devices = [device("anchor"), device("a"), device("b"), device("c")];
    const edges = [edge("anchor", "a"), edge("a", "b"), edge("b", "c")];
    const roster = computeTrustRoster(devices, edges, new Set(["anchor"]));
    expect(roster.get("c")?.chainTrusted).toBe(true);
  });
});

describe("hostsSolelyTrustedBy (R5)", () => {
  test("flags hosts whose only live pin is the device", () => {
    const pins = new Map([
      ["host-solo", ["laptop"]],
      ["host-shared", ["laptop", "root-device"]],
      ["host-other", ["phone"]],
    ]);
    expect(hostsSolelyTrustedBy("laptop", pins)).toEqual(["host-solo"]);
    expect(hostsSolelyTrustedBy("phone", pins)).toEqual(["host-other"]);
    expect(hostsSolelyTrustedBy("root-device", pins)).toEqual([]);
  });
});
