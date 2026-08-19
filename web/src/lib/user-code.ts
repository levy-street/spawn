/**
 * The 8-character pairing code, as a person retypes it.
 *
 * The server mints `XXXX-XXXX` over an alphabet with no `0`, `O`, `1` or `I`
 * (`USER_CODE_ALPHABET`, `routes/device.py`), specifically so a human reading
 * it off a terminal cannot pick the wrong one. That care is wasted if the
 * form then rejects what they typed for having no dash, or a space, or lower
 * case — all of which are the same code.
 */

const CODE_CHARS = /[^A-Z2-9]/gu;
const GROUP = 4;
const GROUPS = 2;

export const USER_CODE_LENGTH = GROUP * GROUPS;

/** Canonical form, for sending to the server. Empty when nothing usable is left. */
export function normalizeUserCode(value: string): string {
  const chars = value.toUpperCase().replace(CODE_CHARS, "").slice(0, USER_CODE_LENGTH);
  if (chars.length <= GROUP) return chars;
  return `${chars.slice(0, GROUP)}-${chars.slice(GROUP)}`;
}

/** Whether a normalized code is complete enough to be worth sending. */
export function isCompleteUserCode(value: string): boolean {
  return normalizeUserCode(value).replace("-", "").length === USER_CODE_LENGTH;
}
