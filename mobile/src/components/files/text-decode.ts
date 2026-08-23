const SNIFF_BYTES = 4096;

export interface DecodedText {
  text: string;
  truncated: boolean;
  lineCount: number;
}

export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

export function partialTailLength(bytes: Uint8Array): number {
  const end = bytes.length;
  if (end === 0) return 0;
  let index = end - 1;
  const floor = Math.max(0, end - 4);
  while (index >= floor && ((bytes[index] ?? 0) & 0b1100_0000) === 0b1000_0000) index -= 1;
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

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lines += 1;
  }
  return lines;
}

export function decodeText(
  bytes: Uint8Array,
  options: { partial?: boolean; maxBytes?: number; maxLines?: number } = {},
): DecodedText {
  const { partial = false, maxBytes, maxLines } = options;
  let truncated = false;
  let view = bytes;
  if (maxBytes !== undefined && view.length > maxBytes) {
    view = view.subarray(0, maxBytes);
    truncated = true;
  }
  if (partial || truncated) {
    const tail = partialTailLength(view);
    if (tail > 0) {
      view = view.subarray(0, view.length - tail);
      truncated = true;
    }
  }
  let text = new TextDecoder("utf-8").decode(view);
  if (text.charCodeAt(0) === 0xfe_ff) text = text.slice(1);
  text = text.replace(/\r\n/g, "\n");
  let lineCount = countLines(text);
  if (maxLines !== undefined && lineCount > maxLines) {
    text = text.split("\n", maxLines).join("\n");
    lineCount = maxLines;
    truncated = true;
  }
  return { text, truncated, lineCount };
}
