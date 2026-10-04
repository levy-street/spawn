/**
 * Words the host surfaces share with the browser, kept identical to it.
 *
 * The refusal copy mirrors web/src/lib/signed-rtc-trust.ts word for word for
 * the reasons a phone shows: one honest explanation per refusal, and for a
 * changed identity the one safe exit.
 * There is deliberately no "accept the new identity" path anywhere — the
 * owner's own reinstall is indistinguishable from an impersonator by design, so
 * the copy explains the fork instead of accusing, and the exit is removal and a
 * fresh possession from the host's own terminal.
 */
export type SignedRtcRefusalReason =
  /** The server presented a different key than the one this device approved. */
  "host_key_substituted";

export const SIGNED_RTC_REFUSAL_DETAIL: Record<SignedRtcRefusalReason, string> = {
  host_key_substituted:
    "This host answered with a different identity than the one this device approved. Either the host's software was reinstalled — a reinstall gives it a new identity — or something between you and the host is impersonating it. This device won't connect either way.",
};

export const SIGNED_RTC_REFUSAL_NEXT_STEP: Record<SignedRtcRefusalReason, string> = {
  host_key_substituted:
    "If you reinstalled this host yourself, remove it here, then run `spawnd possess` in its terminal — possessing it again is the re-verification.",
};

/** The identity-conflict panel's title on the host page. */
export const HOST_IDENTITY_CONFLICT_TITLE =
  "This host's identity changed — connections are blocked";

/** Why the host page's connections stay closed while that panel is up. */
export const HOST_IDENTITY_BLOCKED_REASON =
  "Connections to this host are blocked until it is removed and possessed again.";

/** What removing a host does, everywhere a host can be removed. */
export const REMOVE_HOST_DESCRIPTION =
  "Its daemon token is revoked and SPAWN D stops connecting to it. Sessions already running there may keep running on that host.";
