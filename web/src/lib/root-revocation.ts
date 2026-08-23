/**
 * Corroborate a server claim that a firsthand-known root key was revoked,
 * before anything destructive or trust-moving acts on it (hardening B2).
 *
 * The mutable roster row alone is not evidence: a fabricated `revoked_at`
 * would trigger a rotation. So the claim must ALSO appear in the account's
 * permanent, add-only key tombstone table (`revoked_browser_keys`) — the
 * server can still lie, but only by committing the lie into permanent
 * deny-list state that irreversibly bans the key everywhere, a visible and
 * self-defeating commitment rather than a free roster edit. Any half-claim is
 * `uncorroborated`: the caller must NOT act, and should say so out loud.
 *
 * Shared by the unlock-time rotation trigger (account-heal.ts) and the
 * root-introduction rotation acceptance (root-introduction.ts) — one
 * corroboration rule, one implementation.
 */
export function assessSealedRootRevocation(
  sealedRootPublicKey: string,
  devices: readonly { public_key: string; revoked_at: string | null }[],
  tombstonedKeys: readonly string[],
): "live" | "revoked" | "uncorroborated" {
  const rosterClaimsRevoked = devices.some(
    (d) => d.public_key === sealedRootPublicKey && d.revoked_at !== null,
  );
  const tombstoned = tombstonedKeys.includes(sealedRootPublicKey);
  if (rosterClaimsRevoked && tombstoned) return "revoked";
  if (!rosterClaimsRevoked && !tombstoned) return "live";
  return "uncorroborated";
}
