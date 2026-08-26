import { encodeBase64Url, encodeHex } from "@/lib/crypto/bytes";
import {
  CEREMONY_SAS_DIGITS,
  ceremonySas,
  commitWire,
  freshSasNonce,
  sas,
  sasCommit,
  verifyCommitWire,
} from "@/lib/crypto/sas";

// The vectors shared with daemon/src/sas.rs and web/src/lib/sas.ts. A drift
// here would make the phone and the browser show different numbers for the
// same ceremony, which reads as "the other device is lying" — the exact
// signal the human is told to stop on.
const ONES = new Uint8Array(32).fill(1);
const TWOS = new Uint8Array(32).fill(2);
const THREES = new Uint8Array(32).fill(3);
const FOURS = new Uint8Array(32).fill(4);

describe("committed-ephemeral SAS", () => {
  test("matches the shared six-digit vectors", () => {
    expect(sas(ONES, TWOS, THREES, FOURS)).toBe("449 728");
    const ascending = Uint8Array.from({ length: 64 }, (_, i) => i);
    expect(
      sas(
        ascending.slice(0, 32),
        ascending.slice(32),
        new Uint8Array(32).fill(0xaa),
        new Uint8Array(32).fill(0xbb),
      ),
    ).toBe("108 396");
  });

  test("matches the shared commitment vector", () => {
    const hex = encodeHex(sasCommit(ONES, THREES));
    expect(hex.startsWith("914ede51")).toBe(true);
    expect(hex.endsWith("9958a044")).toBe(true);
  });

  test("derives the four-digit device number the web derives", () => {
    expect(CEREMONY_SAS_DIGITS).toBe(4);
    expect(
      ceremonySas(
        encodeBase64Url(ONES),
        encodeBase64Url(TWOS),
        encodeBase64Url(THREES),
        encodeBase64Url(FOURS),
      ),
    ).toBe("9728");
  });

  test("a matching revealed nonce opens the commitment; a substituted one does not", () => {
    const commitment = commitWire(encodeBase64Url(ONES), THREES);
    expect(verifyCommitWire(commitment, encodeBase64Url(ONES), encodeBase64Url(THREES))).toBe(true);
    expect(
      verifyCommitWire(
        commitment,
        encodeBase64Url(ONES),
        encodeBase64Url(new Uint8Array(32).fill(9)),
      ),
    ).toBe(false);
    // A different claimed key does not open it either: the nonce is bound to
    // the key the committer named.
    expect(verifyCommitWire(commitment, encodeBase64Url(TWOS), encodeBase64Url(THREES))).toBe(
      false,
    );
    expect(verifyCommitWire("not-base64url", encodeBase64Url(ONES), encodeBase64Url(THREES))).toBe(
      false,
    );
  });

  test("both sides derive the same number from relayed values", () => {
    const nI = freshSasNonce();
    const nJ = freshSasNonce();
    expect(nI.byteLength).toBe(32);
    const keyI = encodeBase64Url(ONES);
    const keyJ = encodeBase64Url(TWOS);
    const a = ceremonySas(keyI, keyJ, encodeBase64Url(nI), encodeBase64Url(nJ));
    const b = ceremonySas(keyI, keyJ, encodeBase64Url(nI), encodeBase64Url(nJ));
    expect(a).toBe(b);
    expect(a).toMatch(/^\d{4}$/u);
  });
});
