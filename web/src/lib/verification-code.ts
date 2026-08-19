/**
 * A short, human-comparable verification code derived from a host-key
 * fingerprint. The daemon prints it in the terminal and this page shows it, so
 * the operator matches two 6-digit numbers instead of two base64 fingerprints.
 *
 * It is a presentation of the same pinned identity — deterministic from the
 * exact fingerprint string both sides already display — not a new secret. The
 * daemon must compute this identically (see daemon `creds::verification_code`);
 * the shared test vectors below guard both implementations against drift.
 *
 * Vectors (also asserted in daemon/src/creds.rs):
 *   SHA256:WpbwJ-66BpwGjk7s -> "757 961"
 *   SHA256:AAAAAAAAAAAAAAAA -> "130 179"
 *   SHA256:PUAXw-hDiVqStwqn -> "282 487"
 */
export async function verificationCode(fingerprint: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprint)),
  );
  const n = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  const code = n % 1_000_000;
  const s = code.toString().padStart(6, "0");
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}
