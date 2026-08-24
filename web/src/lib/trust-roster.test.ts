import { describe, expect, test } from "bun:test";
import {
  chainReachableFrom,
  hostsSolelyTrustedBy,
  hostsTrustingDevice,
  unprotectedOrphanHostIds,
} from "./trust-roster";

const HOST = "00000000-0000-4000-8000-00000000000a";
const OTHER_HOST = "00000000-0000-4000-8000-00000000000b";
const DEVICE_X = "00000000-0000-4000-8000-000000000101";
const DEVICE_Y = "00000000-0000-4000-8000-000000000102";
const ROOT_DEVICE = "00000000-0000-4000-8000-000000000103";

describe("hostsSolelyTrustedBy (R5)", () => {
  test("REGRESSION (field bug / P-C4): a revoked-root co-pin no longer hides sole-trust", () => {
    // The pins routes now serve transitively-LIVE pins (the daemon's own
    // computation), so a host whose raw rows were {X, revoked-root} arrives
    // here as {X} — and removing X MUST warn as sole-trust. Before the
    // liveness fix the dead root row padded the list to two and silenced the
    // warning exactly when it mattered.
    const pinsByHost = new Map<string, readonly string[]>([[HOST, [DEVICE_X]]]);
    expect(hostsSolelyTrustedBy(DEVICE_X, pinsByHost)).toEqual([HOST]);
  });

  test("a live co-pin (a genuinely shared host) does not warn", () => {
    const pinsByHost = new Map<string, readonly string[]>([[HOST, [DEVICE_X, DEVICE_Y]]]);
    expect(hostsSolelyTrustedBy(DEVICE_X, pinsByHost)).toEqual([]);
  });
});

describe("unprotectedOrphanHostIds (P-C7: the promise gate)", () => {
  test("a host the heal verifiably upgraded is protected", () => {
    expect(unprotectedOrphanHostIds([HOST], { upgradedHostIds: [HOST] }, new Map(), null)).toEqual(
      [],
    );
  });

  test("a host already showing the root anchor in the REFRESHED pins is protected", () => {
    const refreshed = new Map<string, readonly string[]>([[HOST, [DEVICE_X, ROOT_DEVICE]]]);
    expect(
      unprotectedOrphanHostIds([HOST], { upgradedHostIds: [] }, refreshed, ROOT_DEVICE),
    ).toEqual([]);
  });

  test("the field-bug shape blocks: unlock 'succeeded' but nothing was anchored", () => {
    // The passkey lived on an unpinned device: the heal reported no upgraded
    // hosts and no root anchor exists. The old flow proceeded on the promise
    // anyway and orphaned every host; the gate must refuse it now.
    const refreshed = new Map<string, readonly string[]>([[HOST, [DEVICE_X]]]);
    expect(
      unprotectedOrphanHostIds([HOST], { upgradedHostIds: [] }, refreshed, ROOT_DEVICE),
    ).toEqual([HOST]);
  });

  test("a null heal report protects nothing", () => {
    expect(unprotectedOrphanHostIds([HOST], null, new Map(), ROOT_DEVICE)).toEqual([HOST]);
  });

  test("no live root row means the anchor check cannot pass", () => {
    const refreshed = new Map<string, readonly string[]>([[HOST, [DEVICE_X, ROOT_DEVICE]]]);
    expect(unprotectedOrphanHostIds([HOST], { upgradedHostIds: [] }, refreshed, null)).toEqual([
      HOST,
    ]);
  });

  test("an unfetchable refreshed pin list fails closed for that host", () => {
    expect(
      unprotectedOrphanHostIds(
        [HOST, OTHER_HOST],
        { upgradedHostIds: [OTHER_HOST] },
        new Map(),
        ROOT_DEVICE,
      ),
    ).toEqual([HOST]);
  });
});

describe("chainReachableFrom / hostsTrustingDevice (mesh §3 coverage)", () => {
  const PHONE = "00000000-0000-4000-8000-000000000201";
  const live = (id: string) => ({ id, revoked_at: null, is_root: false });
  const devices = [live(DEVICE_X), live(DEVICE_Y), live(PHONE)];
  const edge = (from: string, to: string) => ({ endorser_device_id: from, endorsed_device_id: to });

  test("a device reaches a host through a live account edge from that host's pin", () => {
    expect(chainReachableFrom([DEVICE_X], devices, [edge(DEVICE_X, PHONE)]).has(PHONE)).toBe(true);
    // Not from a pin the host does not hold, and never backwards.
    expect(chainReachableFrom([DEVICE_Y], devices, [edge(DEVICE_X, PHONE)]).has(PHONE)).toBe(false);
    expect(chainReachableFrom([PHONE], devices, [edge(DEVICE_X, PHONE)]).has(DEVICE_X)).toBe(false);
  });

  test("an edge from a revoked device grants nothing", () => {
    const withRevoked = [
      { id: DEVICE_X, revoked_at: "2026-08-24T00:00:00Z", is_root: false },
      live(PHONE),
    ];
    expect(chainReachableFrom([DEVICE_X], withRevoked, [edge(DEVICE_X, PHONE)]).has(PHONE)).toBe(
      false,
    );
  });

  test("the approval a browser signs covers exactly the hosts that trust it", () => {
    const chainHost = { id: HOST, name: "dream", supports_account_chains: true };
    const legacyHost = { id: OTHER_HOST, name: "old", supports_account_chains: false };
    const pinsByHost = new Map<string, readonly string[]>([
      [HOST, [DEVICE_X]],
      [OTHER_HOST, [DEVICE_Y]],
    ]);
    // Directly pinned on the chain host, nothing on the legacy one.
    expect(hostsTrustingDevice(DEVICE_X, [chainHost, legacyHost], pinsByHost, devices, [])).toEqual(
      [chainHost],
    );
    // Chained onto the chain host through X; the legacy host ignores chains.
    const edges = [edge(DEVICE_X, PHONE), edge(DEVICE_Y, PHONE)];
    expect(hostsTrustingDevice(PHONE, [chainHost, legacyHost], pinsByHost, devices, edges)).toEqual(
      [chainHost],
    );
    // Pinned directly on the legacy host: covered there, as before.
    expect(hostsTrustingDevice(DEVICE_Y, [chainHost, legacyHost], pinsByHost, devices, [])).toEqual(
      [legacyHost],
    );
  });
});
