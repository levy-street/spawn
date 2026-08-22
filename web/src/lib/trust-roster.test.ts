import { describe, expect, test } from "bun:test";
import { hostsSolelyTrustedBy, unprotectedOrphanHostIds } from "./trust-roster";

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
