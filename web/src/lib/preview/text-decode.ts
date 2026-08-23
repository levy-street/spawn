/**
 * Turning host bytes into displayable text.
 *
 * Two things make this more than a `TextDecoder` call. First, a head read stops
 * at an arbitrary byte offset, so the last character in the buffer is very
 * often half a UTF-8 sequence — decoding it naively appends a U+FFFD that was
 * never in the file. Second, a "text" file is only text if it actually is:
 * classification comes from the name, and a `.txt` holding a JPEG must degrade
 * to the binary card rather than render mojibake.
 *
 * Pure and DOM-free apart from `TextDecoder`, which exists in Bun.
 */

/** Bytes scanned when deciding whether this is text at all. */
const SNIFF_BYTES = 4096;

export type DecodedText = {
  text: string;
  /** Bytes were dropped — either a partial tail, a byte cap, or a line cap. */
  truncated: boolean;
  lineCount: number;
};

/**
 * A NUL in the first few KiB means binary. This is the same signal the daemon
 * uses, and it is what makes extensionless files work: everything that is
 * genuinely text survives it, and essentially nothing binary does.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * How many bytes at the end of the buffer are an incomplete UTF-8 sequence.
 *
 * Walks back over continuation bytes (`10xxxxxx`) to the lead byte, reads the
 * length the lead declares, and reports the tail only when the buffer stops
 * short of it. Returns 0 for a clean boundary, and for malformed input — a
 * genuine encoding error is the decoder's problem, not ours.
 */
export function partialTailLength(bytes: Uint8Array): number {
  const end = bytes.length;
  if (end === 0) return 0;

  // At most 3 continuation bytes can precede a lead byte in UTF-8.
  let index = end - 1;
  const floor = Math.max(0, end - 4);
  while (index >= floor && (bytes[index] & 0b1100_0000) === 0b1000_0000) index -= 1;
  if (index < floor) return 0;

  const lead = bytes[index];
  if (lead === undefined) return 0;
  let needed: number;
  if ((lead & 0b1000_0000) === 0) needed = 1;
  else if ((lead & 0b1110_0000) === 0b1100_0000) needed = 2;
  else if ((lead & 0b1111_0000) === 0b1110_0000) needed = 3;
  else if ((lead & 0b1111_1000) === 0b1111_0000) needed = 4;
  else return 0;

  const available = end - index;
  return available < needed ? available : 0;
}

/** Strips a UTF-8 byte-order mark, which would otherwise render as U+FEFF. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfe_ff ? text.slice(1) : text;
}

export function decodeText(
  bytes: Uint8Array,
  options: {
    /** The buffer is a head slice, so drop any half character at its end. */
    partial?: boolean;
    /** Refuse to decode more than this many bytes. */
    maxBytes?: number;
    /** Keep at most this many lines. */
    maxLines?: number;
  } = {},
): DecodedText {
  const { partial = false, maxBytes, maxLines } = options;

  let truncated = false;
  let view = bytes;

  if (maxBytes !== undefined && view.length > maxBytes) {
    view = view.subarray(0, maxBytes);
    truncated = true;
  }
  // A byte cap cuts mid-character just as a head read does.
  if (partial || truncated) {
    const tail = partialTailLength(view);
    if (tail > 0) {
      view = view.subarray(0, view.length - tail);
      truncated = true;
    }
  }

  let text = stripBom(new TextDecoder("utf-8").decode(view));
  // Normalise line endings so line counting and rendering agree on Windows
  // files; a lone \r as a terminator is extinct enough to ignore.
  text = text.replace(/\r\n/g, "\n");

  let lineCount = countLines(text);
  if (maxLines !== undefined && lineCount > maxLines) {
    text = text.split("\n", maxLines).join("\n");
    lineCount = maxLines;
    truncated = true;
  }

  return { text, truncated, lineCount };
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") lines += 1;
  }
  return lines;
}
