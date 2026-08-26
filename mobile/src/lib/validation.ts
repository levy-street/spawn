export type StringValidator = (value: string) => string | null;

export const validationCopy = {
  required: "This field is required.",
  email: "Enter a valid email address.",
  signupPasswordTooShort: "Use at least 8 characters.",
  resetPasswordTooShort: "Use at least 12 characters.",
  passwordTooLong: "Use 256 characters or fewer.",
  confirmationMismatch: "Both passwords must match.",
  workspaceNameTooLong: "Use 128 characters or fewer.",
  sessionNameTooLong: "Use 128 characters or fewer.",
} as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export const SIGNUP_PASSWORD_MIN_LENGTH = 8;
export const RESET_PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
export const WORKSPACE_NAME_MAX_LENGTH = 128;
export const SESSION_NAME_MAX_LENGTH = 128;

export function validateRequired(value: string): string | null {
  return value.trim().length === 0 ? validationCopy.required : null;
}

export function validateEmail(value: string): string | null {
  if (value.length === 0) return null;
  return EMAIL_PATTERN.test(value.trim()) ? null : validationCopy.email;
}

export function minLength(minimum: number, error = `Use at least ${minimum} characters.`) {
  return (value: string): string | null => (value.length < minimum ? error : null);
}

export function maxLength(maximum: number, error = `Use ${maximum} characters or fewer.`) {
  return (value: string): string | null => (value.length > maximum ? error : null);
}

export function matchingConfirmation(
  expected: string,
  error = validationCopy.confirmationMismatch,
): StringValidator {
  return (value: string): string | null => (value === expected ? null : error);
}

export function validateSignupPassword(value: string): string | null {
  if (value.length < SIGNUP_PASSWORD_MIN_LENGTH) return validationCopy.signupPasswordTooShort;
  if (value.length > PASSWORD_MAX_LENGTH) return validationCopy.passwordTooLong;
  return null;
}

export function validateResetPassword(value: string): string | null {
  if (value.length < RESET_PASSWORD_MIN_LENGTH) return validationCopy.resetPasswordTooShort;
  if (value.length > PASSWORD_MAX_LENGTH) return validationCopy.passwordTooLong;
  return null;
}

export function validateWorkspaceName(value: string): string | null {
  const requiredError = validateRequired(value);
  if (requiredError !== null) return requiredError;
  return value.trim().length > WORKSPACE_NAME_MAX_LENGTH
    ? validationCopy.workspaceNameTooLong
    : null;
}

export function validateSessionName(value: string): string | null {
  return value.trim().length > SESSION_NAME_MAX_LENGTH ? validationCopy.sessionNameTooLong : null;
}
