import {
  approvedHostCount,
  canApproveOnHost,
  type HostPinIds,
} from "@/components/settings/browser-devices-panel";
import { pinIdsByStanding } from "@/data/trust/chain-reach";

// #138, the phone's Devices settings: a host that has not confirmed an
// approval still counts toward the device being approved, but this phone
// approves others on a host only where the host has confirmed this phone.

const PHONE = "aa03db41-655e-450f-95fe-96464416292a";
const LAPTOP = "b6b3d3d0-4d8b-4f53-9b1f-3a0d9b6f1e21";
const TABLET = "c1d2e3f4-0a1b-4c2d-8e3f-405162738495";

type Reason = "pin_limit" | "invalid_chain" | "other" | null;

/** One host's pins as the panel splits them. */
function host(...pins: Array<[string, Reason]>): HostPinIds {
  const { recorded, confirmed } = pinIdsByStanding(
    pins.map(([id, reason]) => ({
      browser_device_id: id,
      delivered: reason === null,
      undelivered_reason: reason,
    })),
  );
  return { deviceIds: recorded, confirmedIds: confirmed };
}

describe("the Devices settings rows", () => {
  test("a device whose pin a host has not confirmed is approved there; a rejected one is not", () => {
    const hosts = [host([LAPTOP, "other"]), host([LAPTOP, "pin_limit"]), host([LAPTOP, null])];
    expect(approvedHostCount(hosts, LAPTOP)).toBe(3);
    expect(approvedHostCount([host([LAPTOP, "invalid_chain"])], LAPTOP)).toBe(0);
  });

  test("this phone approves others only on a host that confirmed this phone", () => {
    expect(canApproveOnHost(host([PHONE, null]), PHONE, TABLET)).toBe(true);
    expect(canApproveOnHost(host([PHONE, "other"]), PHONE, TABLET)).toBe(false);
    expect(canApproveOnHost(host([PHONE, "pin_limit"]), PHONE, TABLET)).toBe(false);
    expect(canApproveOnHost(host([PHONE, "invalid_chain"]), PHONE, TABLET)).toBe(false);
  });

  test("a host that already records the other device, confirmed or not, needs nothing more", () => {
    expect(canApproveOnHost(host([PHONE, null], [TABLET, "other"]), PHONE, TABLET)).toBe(false);
    expect(canApproveOnHost(host([PHONE, null], [TABLET, null]), PHONE, TABLET)).toBe(false);
    // A rejected record of it is not a record: approving it there is useful.
    expect(canApproveOnHost(host([PHONE, null], [TABLET, "invalid_chain"]), PHONE, TABLET)).toBe(
      true,
    );
  });
});
