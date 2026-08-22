import {
  AUTH_GATE_DESTINATIONS,
  createUnauthenticatedRedirect,
  resolveAuthGateDestination,
  shouldRenderAuthPath,
} from "@/lib/auth-gate";

describe("resolveAuthGateDestination", () => {
  const booleans = [false, true] as const;
  const hostCounts = [0, 1] as const;

  for (const hasToken of booleans) {
    for (const emailVerified of booleans) {
      for (const verificationRequired of booleans) {
        for (const hostCount of hostCounts) {
          it(`routes token=${hasToken} verified=${emailVerified} enforced=${verificationRequired} hosts=${hostCount}`, () => {
            const expected = !hasToken
              ? AUTH_GATE_DESTINATIONS.login
              : verificationRequired && !emailVerified
                ? AUTH_GATE_DESTINATIONS.verifyEmail
                : hostCount === 0
                  ? AUTH_GATE_DESTINATIONS.onboarding
                  : AUTH_GATE_DESTINATIONS.tabs;

            expect(
              resolveAuthGateDestination({
                hasToken,
                emailVerified,
                verificationRequired,
                hostCount,
              }),
            ).toBe(expected);
          });
        }
      }
    }
  }
});

describe("auth path handling", () => {
  it("keeps public recovery links reachable while signed out", () => {
    expect(shouldRenderAuthPath("/reset-password", AUTH_GATE_DESTINATIONS.login, false)).toBe(true);
    expect(shouldRenderAuthPath("/verify-email", AUTH_GATE_DESTINATIONS.login, false)).toBe(true);
  });

  it("does not send an authenticated deep link back to the tab root", () => {
    expect(shouldRenderAuthPath("/host/abc", AUTH_GATE_DESTINATIONS.tabs, true)).toBe(true);
    expect(shouldRenderAuthPath("/terminal/abc", AUTH_GATE_DESTINATIONS.tabs, true)).toBe(true);
  });
});

describe("createUnauthenticatedRedirect", () => {
  it("routes repeated 401 events to login exactly once per authenticated generation", () => {
    const replace = jest.fn();
    const redirect = createUnauthenticatedRedirect(replace);

    redirect.redirect();
    redirect.redirect();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(AUTH_GATE_DESTINATIONS.login);

    redirect.reset();
    redirect.redirect();
    expect(replace).toHaveBeenCalledTimes(2);
  });
});
