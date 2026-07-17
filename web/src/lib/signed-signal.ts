import { Point as Ed25519Point } from "@noble/ed25519";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const SIGNED_SIGNAL_MAGIC = textEncoder.encode("SPAWN-RTC-SIGNAL-SIG-V1");
export const SIGNED_SIGNAL_VERSION = 1;
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;
export const ED25519_PUBLIC_KEY_WIRE_CHARS = 43;
export const ED25519_SIGNATURE_WIRE_CHARS = 86;
export const MAX_SESSION_ID_BYTES = 256;
export const MAX_SCOPE_ID_BYTES = 256;
export const MAX_SDP_BYTES = 1024 * 1024;

export type SignalKind = "offer" | "answer";
export type ScopeType = "agent" | "host";
export type SenderRole = "browser" | "daemon";

export interface SignedSignalTranscript {
  signalKind: SignalKind;
  protocolVersion: number;
  sessionId: string;
  scopeType: ScopeType;
  scopeId: string;
  senderRole: SenderRole;
  intendedPeerPublicKey: Uint8Array;
  sdp: string;
}

export class SignedSignalError extends Error {
  constructor(
    readonly code:
      | "invalid_base64url"
      | "invalid_enum"
      | "invalid_key"
      | "invalid_length"
      | "invalid_magic"
      | "invalid_number"
      | "invalid_utf8"
      | "trailing_bytes"
      | "truncated"
      | "unsupported_version",
    message: string,
  ) {
    super(message);
    this.name = "SignedSignalError";
  }
}

export class CryptoUnavailableError extends Error {
  constructor() {
    super("WebCrypto SubtleCrypto with Ed25519 support is unavailable");
    this.name = "CryptoUnavailableError";
  }
}

const signalKindCode: Record<SignalKind, number> = { offer: 1, answer: 2 };
const scopeTypeCode: Record<ScopeType, number> = { agent: 1, host: 2 };
const senderRoleCode: Record<SenderRole, number> = { browser: 1, daemon: 2 };

function enumCode<T extends string>(
  value: string,
  codes: Record<T, number>,
  field: string,
): number {
  if (!Object.hasOwn(codes, value)) {
    throw new SignedSignalError("invalid_enum", `invalid ${field}`);
  }
  return codes[value as T];
}

function enumValue<T extends string>(
  value: number,
  values: Readonly<Record<number, T>>,
  field: string,
): T {
  const decoded = values[value];
  if (decoded === undefined) {
    throw new SignedSignalError("invalid_enum", `invalid ${field} enum value ${value}`);
  }
  return decoded;
}

function strictUtf8(value: string, field: string, max: number): Uint8Array {
  const encoded = textEncoder.encode(value);
  if (encoded.byteLength < 1 || encoded.byteLength > max) {
    throw new SignedSignalError("invalid_length", `${field} must encode to 1..=${max} bytes`);
  }
  // TextEncoder replaces lone UTF-16 surrogates. Requiring an exact round trip
  // prevents two JavaScript strings from silently collapsing to the same bytes.
  if (textDecoder.decode(encoded) !== value) {
    throw new SignedSignalError("invalid_utf8", `${field} is not strict Unicode scalar text`);
  }
  return encoded;
}

function ensureBytes(value: Uint8Array, field: string, expected: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== expected) {
    throw new SignedSignalError(
      "invalid_length",
      `${field} must contain exactly ${expected} bytes`,
    );
  }
  return value;
}

function ownedArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

function assertValidEd25519PublicKey(raw: Uint8Array): void {
  ensureBytes(raw, "publicKey", ED25519_PUBLIC_KEY_BYTES);
  try {
    // WebCrypto implementations can import invalid and small-order Ed25519
    // encodings. Use noble's strict RFC 8032 point decoder before handing a
    // key to WebCrypto, then match ed25519-dalek's VerifyingKey::is_weak.
    // This deliberately does not implement curve arithmetic locally.
    if (Ed25519Point.fromBytes(raw, false).isSmallOrder()) {
      throw new SignedSignalError("invalid_key", "weak Ed25519 public key");
    }
  } catch (error) {
    if (error instanceof SignedSignalError) throw error;
    throw new SignedSignalError("invalid_key", "invalid Ed25519 public key");
  }
}

export function encodeSignedSignalTranscript(transcript: SignedSignalTranscript): Uint8Array {
  if (
    !Number.isSafeInteger(transcript.protocolVersion) ||
    transcript.protocolVersion < 1 ||
    transcript.protocolVersion > 0xffff_ffff
  ) {
    throw new SignedSignalError(
      "invalid_number",
      "protocolVersion must be an integer in 1..=2^32-1",
    );
  }
  const sessionId = strictUtf8(transcript.sessionId, "sessionId", MAX_SESSION_ID_BYTES);
  const scopeId = strictUtf8(transcript.scopeId, "scopeId", MAX_SCOPE_ID_BYTES);
  const sdp = strictUtf8(transcript.sdp, "sdp", MAX_SDP_BYTES);
  const peerKey = ensureBytes(
    transcript.intendedPeerPublicKey,
    "intendedPeerPublicKey",
    ED25519_PUBLIC_KEY_BYTES,
  );
  const length =
    SIGNED_SIGNAL_MAGIC.byteLength +
    1 +
    1 +
    4 +
    2 +
    sessionId.byteLength +
    1 +
    2 +
    scopeId.byteLength +
    1 +
    ED25519_PUBLIC_KEY_BYTES +
    4 +
    sdp.byteLength;
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  let offset = 0;
  output.set(SIGNED_SIGNAL_MAGIC, offset);
  offset += SIGNED_SIGNAL_MAGIC.byteLength;
  output[offset++] = SIGNED_SIGNAL_VERSION;
  output[offset++] = enumCode(transcript.signalKind, signalKindCode, "signalKind");
  view.setUint32(offset, transcript.protocolVersion, false);
  offset += 4;
  view.setUint16(offset, sessionId.byteLength, false);
  offset += 2;
  output.set(sessionId, offset);
  offset += sessionId.byteLength;
  output[offset++] = enumCode(transcript.scopeType, scopeTypeCode, "scopeType");
  view.setUint16(offset, scopeId.byteLength, false);
  offset += 2;
  output.set(scopeId, offset);
  offset += scopeId.byteLength;
  output[offset++] = enumCode(transcript.senderRole, senderRoleCode, "senderRole");
  output.set(peerKey, offset);
  offset += ED25519_PUBLIC_KEY_BYTES;
  view.setUint32(offset, sdp.byteLength, false);
  offset += 4;
  output.set(sdp, offset);
  return output;
}

class Reader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly input: Uint8Array) {
    this.view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  }

  take(length: number, field: string): Uint8Array {
    const end = this.offset + length;
    if (!Number.isSafeInteger(length) || length < 0 || end > this.input.byteLength) {
      throw new SignedSignalError("truncated", `truncated transcript while reading ${field}`);
    }
    const value = this.input.slice(this.offset, end);
    this.offset = end;
    return value;
  }

  u8(field: string): number {
    return this.take(1, field)[0];
  }

  u16(field: string): number {
    this.take(2, field);
    const value = this.view.getUint16(this.offset - 2, false);
    return value;
  }

  u32(field: string): number {
    this.take(4, field);
    const value = this.view.getUint32(this.offset - 4, false);
    return value;
  }

  utf8(length: number, field: string, max: number): string {
    if (length < 1 || length > max) {
      throw new SignedSignalError("invalid_length", `invalid ${field} byte length ${length}`);
    }
    const value = this.take(length, field);
    try {
      return textDecoder.decode(value);
    } catch {
      throw new SignedSignalError("invalid_utf8", `invalid UTF-8 in ${field}`);
    }
  }

  remaining(): number {
    return this.input.byteLength - this.offset;
  }
}

export function decodeSignedSignalTranscript(input: Uint8Array): SignedSignalTranscript {
  if (!(input instanceof Uint8Array)) {
    throw new SignedSignalError("invalid_length", "transcript must be a Uint8Array");
  }
  const reader = new Reader(input);
  const magic = reader.take(SIGNED_SIGNAL_MAGIC.byteLength, "magic");
  if (!magic.every((byte, index) => byte === SIGNED_SIGNAL_MAGIC[index])) {
    throw new SignedSignalError("invalid_magic", "invalid transcript magic");
  }
  const version = reader.u8("transcriptVersion");
  if (version !== SIGNED_SIGNAL_VERSION) {
    throw new SignedSignalError("unsupported_version", `unsupported transcript version ${version}`);
  }
  const signalKind = enumValue(reader.u8("signalKind"), { 1: "offer", 2: "answer" }, "signalKind");
  const protocolVersion = reader.u32("protocolVersion");
  if (protocolVersion === 0) {
    throw new SignedSignalError("invalid_number", "protocolVersion must be nonzero");
  }
  const sessionId = reader.utf8(reader.u16("sessionIdLength"), "sessionId", MAX_SESSION_ID_BYTES);
  const scopeType = enumValue(reader.u8("scopeType"), { 1: "agent", 2: "host" }, "scopeType");
  const scopeId = reader.utf8(reader.u16("scopeIdLength"), "scopeId", MAX_SCOPE_ID_BYTES);
  const senderRole = enumValue(
    reader.u8("senderRole"),
    { 1: "browser", 2: "daemon" },
    "senderRole",
  );
  const intendedPeerPublicKey = reader.take(ED25519_PUBLIC_KEY_BYTES, "intendedPeerPublicKey");
  const sdp = reader.utf8(reader.u32("sdpLength"), "sdp", MAX_SDP_BYTES);
  if (reader.remaining() !== 0) {
    throw new SignedSignalError(
      "trailing_bytes",
      `transcript has ${reader.remaining()} trailing bytes`,
    );
  }
  return {
    signalKind,
    protocolVersion,
    sessionId,
    scopeType,
    scopeId,
    senderRole,
    intendedPeerPublicKey,
    sdp,
  };
}

function subtleCrypto(): SubtleCrypto {
  if (globalThis.crypto?.subtle === undefined) {
    throw new CryptoUnavailableError();
  }
  return globalThis.crypto.subtle;
}

function assertEd25519Key(key: CryptoKey, type: "private" | "public", usage: KeyUsage): void {
  if (key.type !== type || key.algorithm.name !== "Ed25519" || !key.usages.includes(usage)) {
    throw new SignedSignalError("invalid_key", `expected an Ed25519 ${type} key for ${usage}`);
  }
}

export async function generateEd25519IdentityKeyPair(): Promise<CryptoKeyPair> {
  let generated: CryptoKeyPair;
  try {
    generated = (await subtleCrypto().generateKey({ name: "Ed25519" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
  } catch (error) {
    if (error instanceof CryptoUnavailableError) throw error;
    throw new CryptoUnavailableError();
  }
  assertEd25519Key(generated.privateKey, "private", "sign");
  assertEd25519Key(generated.publicKey, "public", "verify");
  if (generated.privateKey.extractable) {
    throw new SignedSignalError("invalid_key", "generated private key must be non-extractable");
  }
  return generated;
}

export async function importEd25519PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  assertValidEd25519PublicKey(raw);
  try {
    const key = await subtleCrypto().importKey(
      "raw",
      ownedArrayBuffer(raw),
      { name: "Ed25519" },
      true,
      ["verify"],
    );
    assertEd25519Key(key, "public", "verify");
    return key;
  } catch (error) {
    if (error instanceof CryptoUnavailableError) throw error;
    throw new SignedSignalError("invalid_key", "invalid Ed25519 public key");
  }
}

export async function exportEd25519PublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
  assertEd25519Key(publicKey, "public", "verify");
  try {
    const raw = new Uint8Array(await subtleCrypto().exportKey("raw", publicKey));
    assertValidEd25519PublicKey(raw);
    return raw;
  } catch (error) {
    if (error instanceof CryptoUnavailableError || error instanceof SignedSignalError) throw error;
    throw new SignedSignalError("invalid_key", "Ed25519 public key is not exportable");
  }
}

export async function signSignedSignalTranscript(
  privateKey: CryptoKey,
  transcript: SignedSignalTranscript,
): Promise<string> {
  assertEd25519Key(privateKey, "private", "sign");
  const encoded = encodeSignedSignalTranscript(transcript);
  try {
    const signature = new Uint8Array(
      await subtleCrypto().sign({ name: "Ed25519" }, privateKey, ownedArrayBuffer(encoded)),
    );
    ensureBytes(signature, "signature", ED25519_SIGNATURE_BYTES);
    return encodeBase64Url(signature);
  } catch (error) {
    if (error instanceof CryptoUnavailableError || error instanceof SignedSignalError) throw error;
    throw new SignedSignalError("invalid_key", "Ed25519 signing failed");
  }
}

export async function verifySignedSignalTranscript(
  publicKey: CryptoKey,
  transcript: SignedSignalTranscript,
  signatureWire: string,
): Promise<boolean> {
  assertEd25519Key(publicKey, "public", "verify");
  const signature = decodeBase64Url(signatureWire, ED25519_SIGNATURE_BYTES);
  const encoded = encodeSignedSignalTranscript(transcript);
  try {
    // Callers can supply a CryptoKey imported outside this module. Re-export
    // and validate it so bypassing importEd25519PublicKey cannot reintroduce a
    // WebCrypto small-order-key forgery.
    await exportEd25519PublicKey(publicKey);
    return await subtleCrypto().verify(
      { name: "Ed25519" },
      publicKey,
      ownedArrayBuffer(signature),
      ownedArrayBuffer(encoded),
    );
  } catch (error) {
    if (error instanceof CryptoUnavailableError || error instanceof SignedSignalError) throw error;
    throw new SignedSignalError("invalid_key", "Ed25519 verification failed");
  }
}

export async function exportEd25519PublicKeyWire(publicKey: CryptoKey): Promise<string> {
  return encodeBase64Url(await exportEd25519PublicKey(publicKey));
}

export async function importEd25519PublicKeyWire(value: string): Promise<CryptoKey> {
  return importEd25519PublicKey(decodeEd25519PublicKeyWire(value));
}

/** Decode one canonical wire key and apply the shared strict point contract. */
export function decodeEd25519PublicKeyWire(value: string): Uint8Array {
  const raw = decodeBase64Url(value, ED25519_PUBLIC_KEY_BYTES);
  assertValidEd25519PublicKey(raw);
  return raw;
}

export function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlEncodedLength(byteLength: number): number {
  return Math.ceil((byteLength * 4) / 3);
}

export function decodeBase64Url(value: string, expectedLength: number): Uint8Array {
  if (
    !Number.isSafeInteger(expectedLength) ||
    expectedLength < 1 ||
    typeof value !== "string" ||
    value.length !== base64UrlEncodedLength(expectedLength)
  ) {
    throw new SignedSignalError("invalid_base64url", "invalid canonical base64url");
  }
  if (value.includes("=") || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new SignedSignalError("invalid_base64url", "invalid canonical base64url");
  }
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  let decoded: Uint8Array;
  try {
    decoded = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new SignedSignalError("invalid_base64url", "invalid canonical base64url");
  }
  if (encodeBase64Url(decoded) !== value || decoded.byteLength !== expectedLength) {
    throw new SignedSignalError("invalid_base64url", "invalid canonical base64url");
  }
  return decoded;
}
