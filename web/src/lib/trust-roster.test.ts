import { describe, expect, test } from "bun:test";
import type { HostPinUndeliveredReason } from "./api";
import {
  chainReachableFrom,
  computeTrustRoster,
  hostPinMap,
  hostsSolelyTrustedBy,
  hostsTrustingDevice,
  pinStanding,
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

// #138: the account's approval and one host's confirmation of it are two
// different states. A host that nacked a pin for a reason that says nothing
// against the approval must not turn every device chained through it into a
// "waiting for approval" device; a host that could not VERIFY the approval
// must not be counted as approving anything.
describe("pinStanding / hostPinMap / computeTrustRoster (#138)", () => {
  const BROWSER = "00000000-0000-4000-8000-000000000301";
  const live = (id: string) => ({ id, revoked_at: null, is_root: false });
  const removed = (id: string) => ({ id, revoked_at: "2026-11-15T00:00:00Z", is_root: false });
  const edge = (from: string, to: string) => ({ endorser_device_id: from, endorsed_device_id: to });
  const pin = (
    id: string,
    undelivered_reason: HostPinUndeliveredReason | null,
    delivered = undelivered_reason === null,
  ) => ({ browser_device_id: id, delivered, undelivered_reason });

  test("every reason the server can record is decided on its own", () => {
    expect(pinStanding(pin(DEVICE_X, null))).toBe("confirmed");
    // A host that could not run its reconcile nacks every pin it was sent,
    // the ones it already holds and still admits included.
    expect(pinStanding(pin(DEVICE_X, "other"))).toBe("unconfirmed");
    // Verified, then no room: the approval stands, the host is full.
    expect(pinStanding(pin(DEVICE_X, "pin_limit"))).toBe("unconfirmed");
    // The host checked the approval and could not verify it.
    expect(pinStanding(pin(DEVICE_X, "invalid_chain"))).toBe("rejected");
    // A rejection is never softened by a contradictory delivered flag.
    expect(pinStanding(pin(DEVICE_X, "invalid_chain", true))).toBe("rejected");
    // Not delivered with no reason: not confirmed, not refused.
    expect(pinStanding(pin(DEVICE_X, null, false))).toBe("unconfirmed");
  });

  test("an unconfirmed pin anchors the account's approval but is not host admission", () => {
    const map = hostPinMap([
      [HOST, [pin(DEVICE_X, "other"), pin(DEVICE_Y, null)]],
      [OTHER_HOST, [pin(ROOT_DEVICE, "pin_limit"), pin(BROWSER, "invalid_chain")]],
    ]);
    expect([...map.anchorDeviceIds].sort()).toEqual([DEVICE_X, DEVICE_Y, ROOT_DEVICE].sort());
    // Per host: only what the host confirmed.
    expect(map.byHost.get(HOST)).toEqual([DEVICE_Y]);
    expect(map.byHost.get(OTHER_HOST)).toEqual([]);
    expect(map.byDevice.get(DEVICE_X)).toBeUndefined();
    expect(map.byDevice.get(DEVICE_Y)).toEqual([HOST]);
    // A rejected pin is neither.
    expect(map.anchorDeviceIds.has(BROWSER)).toBe(false);
  });

  test("REGRESSION: a browser whose only chain runs through an unconfirmed pin is approved", () => {
    // The production shape: one pinned device X, a browser approved by X,
    // and X's pin nacked with `other` by a host whose reconcile could not run.
    const devices = [live(DEVICE_X), live(BROWSER)];
    const map = hostPinMap([[HOST, [pin(DEVICE_X, "other")]]]);
    const roster = computeTrustRoster(devices, [edge(DEVICE_X, BROWSER)], map.anchorDeviceIds);
    expect(roster.get(BROWSER)?.chainTrusted).toBe(true);
    expect(roster.get(DEVICE_X)?.chainTrusted).toBe(true);
    // The same holds when the host is full rather than failing.
    const full = hostPinMap([[HOST, [pin(DEVICE_X, "pin_limit")]]]);
    expect(
      computeTrustRoster(devices, [edge(DEVICE_X, BROWSER)], full.anchorDeviceIds).get(BROWSER)
        ?.chainTrusted,
    ).toBe(true);
  });

  test("a browser nobody approved is still not approved", () => {
    const devices = [live(DEVICE_X), live(BROWSER)];
    const map = hostPinMap([[HOST, [pin(DEVICE_X, "other")]]]);
    expect(computeTrustRoster(devices, [], map.anchorDeviceIds).get(BROWSER)?.chainTrusted).toBe(
      false,
    );
  });

  test("a pin the host could not verify approves nothing", () => {
    const devices = [live(DEVICE_X), live(BROWSER)];
    const map = hostPinMap([[HOST, [pin(DEVICE_X, "invalid_chain")]]]);
    const roster = computeTrustRoster(devices, [edge(DEVICE_X, BROWSER)], map.anchorDeviceIds);
    expect(roster.get(DEVICE_X)?.chainTrusted).toBe(false);
    expect(roster.get(BROWSER)?.chainTrusted).toBe(false);
  });

  test("removal still ends approval, whatever a pin's delivery state says", () => {
    // A removed device keeps nothing, even with a pin row still listed.
    const map = hostPinMap([[HOST, [pin(DEVICE_X, "other"), pin(BROWSER, "other")]]]);
    expect(
      computeTrustRoster([live(DEVICE_X), removed(BROWSER)], [], map.anchorDeviceIds).get(BROWSER)
        ?.chainTrusted,
    ).toBe(false);
    // And a removed approver's pin seeds nothing below it.
    const viaRemoved = hostPinMap([[HOST, [pin(DEVICE_X, "other")]]]);
    expect(
      computeTrustRoster(
        [removed(DEVICE_X), live(BROWSER)],
        [edge(DEVICE_X, BROWSER)],
        viaRemoved.anchorDeviceIds,
      ).get(BROWSER)?.chainTrusted,
    ).toBe(false);
  });
});
