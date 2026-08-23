const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HEX_PATTERN = /^(?:[0-9a-f]{2})*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function encodeHex(value: Uint8Array): string {
  let output = "";
  for (const byte of value) output += byte.toString(16).padStart(2, "0");
  return output;
}

export function decodeHex(value: string): Uint8Array {
  if (!HEX_PATTERN.test(value)) throw new Error("Hex must be canonical lowercase byte pairs");
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

export function encodeBase64(value: Uint8Array): string {
  let output = "";
  for (let index = 0; index < value.length; index += 3) {
    const first = value[index] ?? 0;
    const hasSecond = index + 1 < value.length;
    const hasThird = index + 2 < value.length;
    const second = value[index + 1] ?? 0;
    const third = value[index + 2] ?? 0;
    const packed = (first << 16) | (second << 8) | third;
    output += BASE64_ALPHABET[(packed >>> 18) & 63];
    output += BASE64_ALPHABET[(packed >>> 12) & 63];
    output += hasSecond ? BASE64_ALPHABET[(packed >>> 6) & 63] : "=";
    output += hasThird ? BASE64_ALPHABET[packed & 63] : "=";
  }
  return output;
}

function decodeBase64Unchecked(value: string): Uint8Array {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64_ALPHABET.indexOf(value[index] ?? "A");
    const b = BASE64_ALPHABET.indexOf(value[index + 1] ?? "A");
    const c = value[index + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[index + 2] ?? "A");
    const d = value[index + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[index + 3] ?? "A");
    const packed = (a << 18) | (b << 12) | (c << 6) | d;
    if (offset < output.length) output[offset++] = (packed >>> 16) & 0xff;
    if (offset < output.length) output[offset++] = (packed >>> 8) & 0xff;
    if (offset < output.length) output[offset++] = packed & 0xff;
  }
  return output;
}

export function decodeBase64(value: string): Uint8Array {
  if (!BASE64_PATTERN.test(value)) throw new Error("Base64 must use canonical padding");
  const decoded = decodeBase64Unchecked(value);
  if (encodeBase64(decoded) !== value) throw new Error("Base64 is not canonical");
  return decoded;
}

export function encodeBase64Url(value: Uint8Array): string {
  return encodeBase64(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw new Error("Base64url must be canonical and unpadded");
  }
  const paddingLength = (4 - (value.length % 4)) % 4;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(paddingLength);
  const decoded = decodeBase64Unchecked(standard);
  if (encodeBase64Url(decoded) !== value) throw new Error("Base64url is not canonical");
  return decoded;
}

export function decodeBase64UrlExact(value: string, length: number): Uint8Array {
  const decoded = decodeBase64Url(value);
  if (decoded.length !== length) {
    throw new Error(`Base64url value must decode to exactly ${length} bytes`);
  }
  return decoded;
}

function assertValidUtf16(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) throw new Error("String contains an unpaired surrogate");
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) throw new Error("String contains an unpaired surrogate");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("String contains an unpaired surrogate");
    }
  }
}

export function encodeUtf8(value: string): Uint8Array {
  assertValidUtf16(value);
  const output: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const low = value.charCodeAt(++index);
      codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
    }
    if (codePoint <= 0x7f) output.push(codePoint);
    else if (codePoint <= 0x7ff) {
      output.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      output.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      output.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(output);
}

export const encodeUtf8Strict = encodeUtf8;

export function decodeUtf8(value: Uint8Array): string {
  let output = "";
  for (let index = 0; index < value.length; ) {
    const first = value[index] ?? 0;
    let codePoint: number;
    let width: number;
    if (first <= 0x7f) {
      codePoint = first;
      width = 1;
    } else if (first >= 0xc2 && first <= 0xdf) {
      codePoint = first & 0x1f;
      width = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      codePoint = first & 0x0f;
      width = 3;
    } else if (first >= 0xf0 && first <= 0xf4) {
      codePoint = first & 0x07;
      width = 4;
    } else throw new Error("Invalid UTF-8 leading byte");

    if (index + width > value.length) throw new Error("Truncated UTF-8 sequence");
    for (let offset = 1; offset < width; offset += 1) {
      const next = value[index + offset] ?? 0;
      if ((next & 0xc0) !== 0x80) throw new Error("Invalid UTF-8 continuation byte");
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    const minimum = width === 1 ? 0 : width === 2 ? 0x80 : width === 3 ? 0x800 : 0x10000;
    if (
      codePoint < minimum ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      throw new Error("Non-canonical UTF-8 sequence");
    }
    output += String.fromCodePoint(codePoint);
    index += width;
  }
  return output;
}

export const decodeUtf8Strict = decodeUtf8;

export function parseCanonicalUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error("UUID must use canonical lowercase syntax");
  return value;
}

export function uuidToBytes(value: string): Uint8Array {
  return decodeHex(parseCanonicalUuid(value).replaceAll("-", ""));
}

export function bytesToUuid(value: Uint8Array): string {
  if (value.length !== 16) throw new Error("UUID bytes must be exactly 16 bytes");
  const hex = encodeHex(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
