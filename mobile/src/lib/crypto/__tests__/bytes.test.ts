import {
  bytesToUuid,
  decodeBase64,
  decodeBase64Url,
  decodeHex,
  decodeUtf8,
  encodeBase64,
  encodeBase64Url,
  encodeHex,
  encodeUtf8,
  uuidToBytes,
} from "@/lib/crypto/bytes";

describe("crypto byte codecs", () => {
  test.each([
    new Uint8Array(),
    Uint8Array.of(0),
    Uint8Array.of(0, 1),
    Uint8Array.of(0, 1, 2),
    Uint8Array.of(0xfb, 0xff, 0xef, 0x01),
  ])("round-trips base64 and base64url padding edges", (bytes) => {
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
  });

  test.each(["Zg", "Zg===", "Z g==", "Zg==\n", "_w=="])(
    "rejects non-canonical base64 %s",
    (value) => {
      expect(() => decodeBase64(value)).toThrow();
    },
  );

  test.each(["_w==", "/w", "_ w", "A"])("rejects non-canonical base64url %s", (value) => {
    expect(() => decodeBase64Url(value)).toThrow();
  });

  test.each(["spawn", "Grüße", "Aotearoa 🥝", "𐍈", "\0terminal"])(
    "round-trips strict UTF-8 for %s",
    (value) => {
      expect(decodeUtf8(encodeUtf8(value))).toBe(value);
    },
  );

  test("rejects malformed UTF-8 and unpaired UTF-16 surrogates", () => {
    expect(() => decodeUtf8(Uint8Array.of(0xc0, 0x80))).toThrow();
    expect(() => decodeUtf8(Uint8Array.of(0xed, 0xa0, 0x80))).toThrow();
    expect(() => decodeUtf8(Uint8Array.of(0xf4, 0x90, 0x80, 0x80))).toThrow();
    expect(() => encodeUtf8("\ud800")).toThrow();
  });

  test("round-trips canonical lowercase hex and UUID bytes", () => {
    const bytes = Uint8Array.of(0, 1, 15, 16, 254, 255);
    expect(decodeHex(encodeHex(bytes))).toEqual(bytes);
    const uuid = "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1";
    expect(bytesToUuid(uuidToBytes(uuid))).toBe(uuid);
    expect(() => uuidToBytes(uuid.toUpperCase())).toThrow();
    expect(() => decodeHex("AF")).toThrow();
  });
});
