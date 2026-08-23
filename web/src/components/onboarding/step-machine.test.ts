import { describe, expect, test } from "bun:test";
import { deriveStep, parseRequestedStep, resolveStep } from "./step-machine";

const verifiedUser = { email_verified_at: "2026-08-19T00:00:00Z" };
const unverifiedUser = { email_verified_at: null };

describe("deriveStep", () => {
  test("requires an account before every later gate", () => {
    expect(
      deriveStep({
        user: null,
        config: { email_verification_required: true },
        hosts: [],
        skippedHost: false,
      }),
    ).toBe("account");
  });

  test("requires verification only when the server enforces it", () => {
    expect(
      deriveStep({
        user: unverifiedUser,
        config: { email_verification_required: true },
        hosts: [],
        skippedHost: false,
      }),
    ).toBe("verify");
    expect(
      deriveStep({
        user: unverifiedUser,
        config: { email_verification_required: false },
        hosts: [],
        skippedHost: false,
      }),
    ).toBe("host");
  });

  test("requires a host after account and verification are satisfied", () => {
    expect(
      deriveStep({
        user: verifiedUser,
        config: { email_verification_required: true },
        hosts: [],
        skippedHost: false,
      }),
    ).toBe("host");
  });

  test("finishes when a host exists or the host gate was skipped", () => {
    expect(
      deriveStep({
        user: verifiedUser,
        config: { email_verification_required: true },
        hosts: [{}],
        skippedHost: false,
      }),
    ).toBe("done");
    expect(
      deriveStep({
        user: verifiedUser,
        config: { email_verification_required: true },
        hosts: [],
        skippedHost: true,
      }),
    ).toBe("done");
  });

  test("never lets a deep link bypass or revive a satisfied gate", () => {
    const input = {
      user: unverifiedUser,
      config: { email_verification_required: true },
      hosts: [] as unknown[],
      skippedHost: false,
    };
    expect(resolveStep(input, "host")).toBe("verify");
    expect(resolveStep(input, "verify")).toBe("verify");
    expect(resolveStep({ ...input, user: verifiedUser }, "account")).toBe("host");
  });
});

describe("parseRequestedStep", () => {
  test("accepts only known steps", () => {
    expect(parseRequestedStep("host")).toBe("host");
    expect(parseRequestedStep("bogus")).toBeNull();
    expect(parseRequestedStep(null)).toBeNull();
  });
});
