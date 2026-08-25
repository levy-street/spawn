import { describe, expect, test } from "bun:test";
import { hostPinCapacityWarning, hostPinUndeliveredEventToast } from "./host-pin-hygiene";

describe("host approval capacity", () => {
  test("warns at 28 devices, not before, with the exact recovery copy", () => {
    expect(hostPinCapacityWarning({ used: 27, max: 32 })).toBeNull();
    expect(hostPinCapacityWarning({ used: 28, max: 32 })).toBe(
      "This host is close to its limit of approving devices (28 of 32). Remove devices you no longer use under Access.",
    );
    expect(hostPinCapacityWarning({ used: 32, max: 32 })).toContain("(32 of 32)");
  });
});

describe("undelivered host approval alerts", () => {
  test("maps every wire reason to the exact toast sentence", () => {
    expect(hostPinUndeliveredEventToast({ reason: "pin_limit" }, "mac-studio")).toBe(
      "The approval didn't reach mac-studio. This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again.",
    );
    expect(hostPinUndeliveredEventToast({ reason: "invalid_chain" }, "mac-studio")).toBe(
      "The approval didn't reach mac-studio. mac-studio could not verify the approval. Approve the device again from a device mac-studio already trusts.",
    );
    expect(hostPinUndeliveredEventToast({ reason: "other" }, "mac-studio")).toBe(
      "The approval didn't reach mac-studio. Try approving again; if it keeps failing, run spawnd doctor on mac-studio.",
    );
  });
});
