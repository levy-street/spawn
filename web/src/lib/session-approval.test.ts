import { describe, expect, it } from "bun:test";
import {
  approvalToastEligible,
  isAgentSessionPath,
  pickApprovalToastDevice,
} from "./session-approval";

describe("isAgentSessionPath", () => {
  it("matches exactly the surfaces that host a live terminal", () => {
    expect(isAgentSessionPath("/agents/abc-123")).toBe(true);
    expect(isAgentSessionPath("/agents/abc-123/")).toBe(true);
    expect(isAgentSessionPath("/screens/screen-1")).toBe(true);
  });

  it("never matches list, create, or unrelated routes", () => {
    expect(isAgentSessionPath(null)).toBe(false);
    expect(isAgentSessionPath("/agents")).toBe(false);
    expect(isAgentSessionPath("/agents/new")).toBe(false);
    expect(isAgentSessionPath("/screens")).toBe(false);
    expect(isAgentSessionPath("/agents/abc/extra")).toBe(false);
    expect(isAgentSessionPath("/hosts")).toBe(false);
    expect(isAgentSessionPath("/")).toBe(false);
  });
});

describe("approvalToastEligible", () => {
  const ignoredAt = Date.parse("2026-08-21T12:00:00Z");

  it("is always eligible while never ignored", () => {
    expect(approvalToastEligible({ approval_requested_at: null }, undefined)).toBe(true);
    expect(
      approvalToastEligible({ approval_requested_at: "2026-08-21T11:00:00Z" }, undefined),
    ).toBe(true);
  });

  it("stays ignored without a fresh ask", () => {
    expect(approvalToastEligible({ approval_requested_at: null }, ignoredAt)).toBe(false);
    expect(
      approvalToastEligible({ approval_requested_at: "2026-08-21T11:59:59Z" }, ignoredAt),
    ).toBe(false);
  });

  it("a fresh ask re-raises an ignored device", () => {
    expect(
      approvalToastEligible({ approval_requested_at: "2026-08-21T12:00:01Z" }, ignoredAt),
    ).toBe(true);
  });

  it("an unparsable stamp never re-raises", () => {
    expect(approvalToastEligible({ approval_requested_at: "not-a-date" }, ignoredAt)).toBe(false);
  });
});

describe("pickApprovalToastDevice", () => {
  it("returns null for an empty list and keeps list order without asks", () => {
    expect(pickApprovalToastDevice([])).toBeNull();
    const quiet = [
      { id: "a", approval_requested_at: null },
      { id: "b", approval_requested_at: null },
    ];
    expect(pickApprovalToastDevice(quiet)?.id).toBe("a");
  });

  it("an active ask outranks list order, and the latest ask wins", () => {
    const devices = [
      { id: "quiet", approval_requested_at: null },
      { id: "older-ask", approval_requested_at: "2026-08-21T11:00:00Z" },
      { id: "newer-ask", approval_requested_at: "2026-08-21T12:00:00Z" },
    ];
    expect(pickApprovalToastDevice(devices)?.id).toBe("newer-ask");
  });
});
