import { describe, expect, test } from "bun:test";
import { ApiError } from "./api";
import { BrowserDeviceIdentityError } from "./browser-device-identity";
import {
  describeBrowserDeviceRegistrationFailure,
  isRevokedDeviceKeyRefusal,
} from "./browser-device-registration";
import { CryptoUnavailableError } from "./signed-signal";

describe("describing a failed browser device registration", () => {
  test("a browser that cannot make the key is told so, and offered no reload", () => {
    const failure = describeBrowserDeviceRegistrationFailure(new CryptoUnavailableError());
    expect(failure.reason).toContain("Ed25519");
    expect(failure.remedy).toContain("Chrome");
    // Reloading runs the same unsupported call into the same browser.
    expect(failure.canRetry).toBe(false);
  });

  test("a storage cause says which one it is", () => {
    const unavailable = describeBrowserDeviceRegistrationFailure(
      new BrowserDeviceIdentityError("storage_unavailable", "IndexedDB is unavailable"),
    );
    expect(unavailable.reason).toContain("nowhere to keep");
    expect(unavailable.canRetry).toBe(false);

    // A write that failed once may not fail twice.
    const failed = describeBrowserDeviceRegistrationFailure(
      new BrowserDeviceIdentityError("storage_failure", "write failed"),
    );
    expect(failed.reason).toContain("could not save");
    expect(failed.canRetry).toBe(true);
  });

  test("a damaged or crowded store names what clearing site data would do", () => {
    for (const code of ["corrupt_record", "capacity_exceeded"] as const) {
      const failure = describeBrowserDeviceRegistrationFailure(
        new BrowserDeviceIdentityError(code, "stored identity is unusable"),
      );
      expect(failure.remedy).toContain("Clearing this site's data");
      expect(failure.canRetry).toBe(false);
    }
  });

  test("a server refusal is quoted, and only an overloaded server is asked twice", () => {
    const refused = describeBrowserDeviceRegistrationFailure(
      new ApiError(409, "http_409", "revoked browser public keys cannot be registered again"),
    );
    expect(refused.reason).toContain("revoked browser public keys");
    expect(refused.canRetry).toBe(false);

    expect(
      describeBrowserDeviceRegistrationFailure(new ApiError(503, "http_503", "Service Unavailable"))
        .canRetry,
    ).toBe(true);
  });

  test("machine-readable refusal codes drive registration guidance", () => {
    const revoked = describeBrowserDeviceRegistrationFailure(
      new ApiError(409, "device_key_revoked", "legacy wording can change"),
    );
    expect(revoked.reason).toContain("permanently refused");
    expect(revoked.canRetry).toBe(false);

    const owned = describeBrowserDeviceRegistrationFailure(
      new ApiError(409, "device_key_owned_by_other_account", "conflict"),
    );
    expect(owned.reason).toContain("another account");

    const proof = describeBrowserDeviceRegistrationFailure(
      new ApiError(422, "registration_proof_invalid", "bad proof"),
    );
    expect(proof.reason).toContain("registration proof");
    expect(proof.canRetry).toBe(false);
  });

  test("revoked-key self-heal prefers the code and limits the old-server heuristic", () => {
    expect(
      isRevokedDeviceKeyRefusal(new ApiError(409, "device_key_revoked", "not message keyed")),
    ).toBe(true);
    expect(
      isRevokedDeviceKeyRefusal(
        new ApiError(409, "http_409", "revoked browser public keys cannot be registered again"),
      ),
    ).toBe(true);
    expect(
      isRevokedDeviceKeyRefusal(new ApiError(409, "root_already_exists", "key was revoked")),
    ).toBe(false);
  });

  test("an unrecognised failure keeps the plain line and the retry", () => {
    const failure = describeBrowserDeviceRegistrationFailure(new TypeError("Failed to fetch"));
    expect(failure.reason).toBe("This browser's identity could not be registered.");
    expect(failure.remedy).toBeNull();
    expect(failure.canRetry).toBe(true);
  });
});
