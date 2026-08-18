/**
 * Deterministic empty-prompt heuristic (§5.5), tracked purely from the bytes
 * the terminal SENDS — no prompt parsing, no output inspection.
 *
 *   - printable characters and bracketed-paste payloads increment a pending
 *     count (a pasted newline is a literal prompt insert, so it counts too)
 *   - Backspace/DEL decrement it (floored at zero)
 *   - Enter, Ctrl+C, Ctrl+U, Ctrl+D reset it to zero
 *   - ESC+CR (the Shift+Enter "insert newline" sequence) counts as one insert
 *   - other escape sequences (arrows, function keys) leave it untouched
 *   - a foreground change resets externally via `reset()`
 *
 * Count 0 ⇔ "empty". Transitions surface through `onChange`.
 */

export type PromptState = "empty" | "typing";

const ESC = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// Longest sequence we hold across feeds while it is still ambiguous.
const MAX_CARRY = 16;

export class PromptStateTracker {
  #count = 0;
  #inPaste = false;
  // Tail of the previous feed that ended mid-escape-sequence (or mid paste-end
  // marker); prepended to the next feed so split sequences parse whole.
  #carry = "";
  onChange: ((state: PromptState) => void) | null = null;

  get state(): PromptState {
    return this.#count > 0 ? "typing" : "empty";
  }

  get pendingCount(): number {
    return this.#count;
  }

  /** External reset — the pane calls this when the foreground process changes. */
  reset(): void {
    this.#inPaste = false;
    this.#carry = "";
    this.#apply(0);
  }

  feed(data: string): void {
    const input = this.#carry + data;
    this.#carry = "";
    let count = this.#count;
    let index = 0;

    while (index < input.length) {
      if (this.#inPaste) {
        const end = input.indexOf(PASTE_END, index);
        const stop = end === -1 ? input.length : end;
        // A partial end-marker at the tail must not be counted as payload.
        let hold = 0;
        if (end === -1) {
          for (
            let probe = Math.max(index, input.length - (PASTE_END.length - 1));
            probe < input.length;
            probe += 1
          ) {
            if (PASTE_END.startsWith(input.slice(probe))) {
              hold = input.length - probe;
              break;
            }
          }
        }
        count += [...input.slice(index, stop - hold)].length;
        if (end === -1) {
          this.#carry = hold > 0 ? input.slice(input.length - hold) : "";
          index = input.length;
        } else {
          this.#inPaste = false;
          index = end + PASTE_END.length;
        }
        continue;
      }

      const char = input[index];
      if (char === ESC) {
        const rest = input.slice(index);
        if (rest.startsWith(PASTE_START)) {
          this.#inPaste = true;
          index += PASTE_START.length;
          continue;
        }
        if (rest.length === 1 || (rest[1] === "[" && !/[\x40-\x7e]/.test(csiTail(rest)))) {
          // Possibly split across feeds: hold the ambiguous tail (bounded).
          if (rest.length <= MAX_CARRY) {
            this.#carry = rest;
            index = input.length;
            continue;
          }
          // Oversized garbage; drop the ESC and keep parsing.
          index += 1;
          continue;
        }
        if (rest[1] === "\r" || rest[1] === "\n") {
          // ESC+CR — "insert newline into the prompt".
          count += 1;
          index += 2;
          continue;
        }
        if (rest[1] === "[") {
          // Complete CSI sequence: skip through its final byte.
          let end = index + 2;
          while (end < input.length && !/[\x40-\x7e]/.test(input[end])) end += 1;
          index = end + 1;
          continue;
        }
        if (rest[1] === "O") {
          // SS3 keys (F1–F4, Home/End in application mode): ESC O <final>.
          index += 3;
          continue;
        }
        // ESC + one other char (alt-key chords): ignore both.
        index += 2;
        continue;
      }

      if (char === "\r" || char === "\n" || char === "\x03" || char === "\x15" || char === "\x04") {
        count = 0;
        index += 1;
        continue;
      }
      if (char === "\x7f" || char === "\x08") {
        count = Math.max(0, count - 1);
        index += 1;
        continue;
      }
      if (char >= " ") {
        // Printable (count whole code points, not UTF-16 halves).
        const codePoint = input.codePointAt(index) ?? 0;
        count += 1;
        index += codePoint > 0xffff ? 2 : 1;
        continue;
      }
      // Remaining control bytes (Tab, …): no effect on the pending count.
      index += 1;
    }

    this.#apply(count);
  }

  #apply(count: number): void {
    const before = this.state;
    this.#count = count;
    const after = this.state;
    if (before !== after) this.onChange?.(after);
  }
}

function csiTail(rest: string): string {
  // Everything after "ESC[" — used only to test for a final byte's presence.
  return rest.slice(2);
}
