import {
  matchingConfirmation,
  maxLength,
  minLength,
  validateEmail,
  validateRequired,
  validateResetPassword,
  validateSessionName,
  validateSignupPassword,
  validateWorkspaceName,
  validationCopy,
} from "@/lib/validation";

describe("validation", () => {
  test("required rejects empty and whitespace-only values", () => {
    expect(validateRequired("")).toBe(validationCopy.required);
    expect(validateRequired(" \n\t ")).toBe(validationCopy.required);
    expect(validateRequired(" value ")).toBeNull();
  });

  test("email accepts a conventional address and rejects malformed values", () => {
    expect(validateEmail("")).toBeNull();
    expect(validateEmail("person@example.com")).toBeNull();
    expect(validateEmail(" person+tag@example.co.nz ")).toBeNull();
    expect(validateEmail("person@example")).toBe(validationCopy.email);
    expect(validateEmail("person @example.com")).toBe(validationCopy.email);
    expect(validateEmail("@example.com")).toBe(validationCopy.email);
  });

  test("signup password enforces the exact 8 to 256 character range", () => {
    expect(validateSignupPassword("a".repeat(7))).toBe(validationCopy.signupPasswordTooShort);
    expect(validateSignupPassword("a".repeat(8))).toBeNull();
    expect(validateSignupPassword("a".repeat(256))).toBeNull();
    expect(validateSignupPassword("a".repeat(257))).toBe(validationCopy.passwordTooLong);
  });

  test("reset password enforces the distinct 12 to 256 character range", () => {
    expect(validateResetPassword("a".repeat(11))).toBe(validationCopy.resetPasswordTooShort);
    expect(validateResetPassword("a".repeat(12))).toBeNull();
    expect(validateResetPassword("a".repeat(256))).toBeNull();
    expect(validateResetPassword("a".repeat(257))).toBe(validationCopy.passwordTooLong);
  });

  test("length factories include both boundaries and accept custom copy", () => {
    expect(minLength(3)("ab")).toBe("Use at least 3 characters.");
    expect(minLength(3)("abc")).toBeNull();
    expect(maxLength(3)("abc")).toBeNull();
    expect(maxLength(3, "Too long")("abcd")).toBe("Too long");
  });

  test("matching confirmation uses the reset form's exact mismatch copy", () => {
    const validateConfirmation = matchingConfirmation("correct horse");
    expect(validateConfirmation("correct horse")).toBeNull();
    expect(validateConfirmation("wrong horse")).toBe(validationCopy.confirmationMismatch);
  });

  test("workspace names are required and capped at 128 trimmed characters", () => {
    expect(validateWorkspaceName("   ")).toBe(validationCopy.required);
    expect(validateWorkspaceName("a".repeat(128))).toBeNull();
    expect(validateWorkspaceName(` ${"a".repeat(128)} `)).toBeNull();
    expect(validateWorkspaceName("a".repeat(129))).toBe(validationCopy.workspaceNameTooLong);
  });

  test("session names may clear to blank but cannot exceed 128 trimmed characters", () => {
    expect(validateSessionName("")).toBeNull();
    expect(validateSessionName("a".repeat(128))).toBeNull();
    expect(validateSessionName(` ${"a".repeat(128)} `)).toBeNull();
    expect(validateSessionName("a".repeat(129))).toBe(validationCopy.sessionNameTooLong);
  });
});
