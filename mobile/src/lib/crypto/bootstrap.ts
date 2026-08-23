import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import * as ExpoCrypto from "expo-crypto";

let ready = false;
const sha512Async: typeof ed.hashes.sha512Async = async (message) => sha512(message);

function installRandomValues(): void {
  if (globalThis.crypto === undefined) {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {},
    });
  }

  if (globalThis.crypto.getRandomValues === undefined) {
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      configurable: true,
      value: ExpoCrypto.getRandomValues,
    });
  }
}

export function ensureCryptoReady(): void {
  if (!ready) {
    installRandomValues();
    ready = true;
  }

  // Reassert the hooks defensively in case import ordering or another package touched Noble's
  // mutable configuration after the initial bootstrap.
  ed.hashes.sha512 = sha512;
  ed.hashes.sha512Async = sha512Async;

  if (
    globalThis.crypto?.getRandomValues === undefined ||
    ed.hashes.sha512 !== sha512 ||
    ed.hashes.sha512Async !== sha512Async
  ) {
    ready = false;
    throw new Error("Crypto bootstrap is incomplete: secure randomness and SHA-512 are required");
  }
}

export function randomBytes(length: number): Uint8Array {
  ensureCryptoReady();
  if (!Number.isSafeInteger(length) || length < 1 || length > 65_536) {
    throw new RangeError("Random byte length must be an integer from 1 through 65536");
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
