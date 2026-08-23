import { decodeHex } from "@/lib/crypto/bytes";
import { assertStrictEd25519PublicKey, verifyPureEd25519Strict } from "@/lib/crypto/ed25519";
import negativeVectors from "../../../../tests/fixtures/ed25519-public-key-negative-vectors.json";

describe("strict Ed25519 public-key validation", () => {
  test.each(negativeVectors.weak_public_keys)("rejects weak key $id", ({ public_key_hex }) => {
    expect(() => assertStrictEd25519PublicKey(decodeHex(public_key_hex))).toThrow();
  });

  test.each(negativeVectors.noncanonical_public_key_hex)(
    "rejects non-canonical key %#",
    (publicKeyHex) => {
      expect(() => assertStrictEd25519PublicKey(decodeHex(publicKeyHex))).toThrow();
    },
  );

  test.each(negativeVectors.invalid_encodings)(
    "rejects invalid encoding $id",
    ({ public_key_hex }) => {
      expect(() => assertStrictEd25519PublicKey(decodeHex(public_key_hex))).toThrow();
    },
  );

  test.each(negativeVectors.accepted_mixed_torsion_public_key_hex)(
    "accepts mixed-torsion validation control %#",
    (publicKeyHex) => {
      expect(() => assertStrictEd25519PublicKey(decodeHex(publicKeyHex))).not.toThrow();
    },
  );

  test("rejects the universal-forgery control", () => {
    const identity = negativeVectors.weak_public_keys.find(
      ({ id }) => id === negativeVectors.universal_forgery.public_key_id,
    );
    expect(identity).toBeDefined();
    if (identity === undefined) return;
    expect(
      verifyPureEd25519Strict(
        decodeHex(identity.public_key_hex),
        new Uint8Array(),
        decodeHex(negativeVectors.universal_forgery.signature_hex),
      ),
    ).toBe(false);
  });
});
