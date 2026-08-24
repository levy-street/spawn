import { describe, expect, it } from "bun:test";
import { isAgentSessionPath } from "./session-approval";

describe("isAgentSessionPath", () => {
  it("matches exactly the surfaces that host a live terminal", () => {
    expect(isAgentSessionPath("/sessions/abc-123")).toBe(true);
    expect(isAgentSessionPath("/sessions/abc-123/")).toBe(true);
    expect(isAgentSessionPath("/w/workspace-1")).toBe(true);
  });

  it("never matches list, create, or unrelated routes", () => {
    expect(isAgentSessionPath(null)).toBe(false);
    expect(isAgentSessionPath("/sessions")).toBe(false);
    expect(isAgentSessionPath("/w")).toBe(false);
    expect(isAgentSessionPath("/sessions/abc/extra")).toBe(false);
    expect(isAgentSessionPath("/hosts")).toBe(false);
    expect(isAgentSessionPath("/app")).toBe(false);
    expect(isAgentSessionPath("/")).toBe(false);
  });

  it("does not match the retired pre-overhaul routes", () => {
    expect(isAgentSessionPath("/agents/abc-123")).toBe(false);
    expect(isAgentSessionPath("/screens/screen-1")).toBe(false);
  });
});
