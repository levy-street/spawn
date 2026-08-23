import { AUTH_GATE_DESTINATIONS, shouldRenderAuthPath } from "@/lib/auth-gate";

// A wrong server URL is otherwise a deadlock: you cannot sign in to reach the
// setting that fixes the address sign-in needs.
describe("signed-out server route", () => {
  it("renders /server while signed out", () => {
    expect(shouldRenderAuthPath("/server", AUTH_GATE_DESTINATIONS.login, false)).toBe(true);
  });

  it("still gates a protected path while signed out", () => {
    expect(shouldRenderAuthPath("/workspaces", AUTH_GATE_DESTINATIONS.login, false)).toBe(false);
  });
});
