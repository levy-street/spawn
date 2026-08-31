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
      }),
    ).toBe("account");
  });

  test("requires verification only when the server enforces it", () => {
    expect(
      deriveStep({
        user: unverifiedUser,
        config: { email_verification_required: true },
        hosts: [],
      }),
    ).toBe("verify");
    expect(
      deriveStep({
        user: unverifiedUser,
        config: { email_verification_required: false },
        hosts: [],
      }),
    ).toBe("host");
  });

  test("requires a host after account and verification are satisfied", () => {
    expect(
      deriveStep({
        user: verifiedUser,
        config: { email_verification_required: true },
        hosts: [],
      }),
    ).toBe("host");
  });

  test("finishes only once a host is actually online", () => {
    expect(
      deriveStep({
        user: verifiedUser,
        config: { email_verification_required: true },
        hosts: [{ status: "online" }],
      }),
    ).toBe("done");
    // There is no way past this gate but through it. An account with no host
    // stays on the host step, because the product does nothing without one and
    // letting someone "skip" only landed them in an app that could not run
    // anything.
    expect(
      deriveStep({
        user: verifiedUser,
        config: { email_verification_required: true },
        hosts: [],
      }),
    ).toBe("host");
  });

  test("keeps an approved-but-offline host in the host hand-off instead of reinstalling", () => {
    expect(
      deriveStep({
        user: verifiedUser,
        config: { email_verification_required: true },
        hosts: [{ status: "offline" }],
      }),
    ).toBe("host");
  });

  test("never lets a deep link bypass or revive a satisfied gate", () => {
    const input = {
      user: unverifiedUser,
      config: { email_verification_required: true },
      hosts: [] as Array<{ status?: string }>,
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
