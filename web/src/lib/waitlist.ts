import { ApiError } from "./api";

/**
 * The waitlist's words. The mobile app says the same things in its own
 * idiom; a change of meaning here is a change there in the same commit.
 */
export const WAITLIST = {
  title: "Join the waitlist",
  body: "SPAWN D is invite-only right now. Leave your email and we’ll send an invite when there’s room.",
  emailLabel: "Email",
  submit: "Join the waitlist",
  submitting: "Joining…",
  joinedTitle: "You’re on the list.",
  joined: (email: string) => `We’ll email ${email} when there’s room.`,
  invalid: "Enter a valid email address.",
  failed: "Could not join the waitlist. Try again in a moment.",
  tooMany: "Too many tries from this network. Try again later.",
  haveInvite: "Have an invite code?",
  backToWaitlist: "Back to the waitlist",
} as const;

/** What to tell someone whose join did not go through. */
export function joinFailureMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) return WAITLIST.tooMany;
  return WAITLIST.failed;
}

/**
 * Whether an address is worth sending. The server's validation is the real
 * one; this only spares a round trip for an obvious slip, and it is lenient
 * on purpose — a strict pattern rejects real addresses.
 */
export function looksLikeEmail(value: string): boolean {
  const address = value.trim();
  return address.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}
