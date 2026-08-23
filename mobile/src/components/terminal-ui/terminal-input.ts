import type { SessionTransport } from "@/terminal/transport/types";

export const TERMINAL_INPUT_CHUNK_BYTES = 64 * 1024;
export const LARGE_PASTE_CONFIRM_BYTES = 100 * 1024;
export const MAX_INTERACTIVE_PASTE_BYTES = 1024 * 1024;

export function chunkTerminalInput(
  bytes: Uint8Array,
  chunkBytes = TERMINAL_INPUT_CHUNK_BYTES,
): Uint8Array[] {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) return [];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    chunks.push(bytes.slice(offset, Math.min(bytes.byteLength, offset + chunkBytes)));
  }
  return chunks;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export async function writeTerminalInput(
  transport: SessionTransport,
  bytes: Uint8Array,
  onProgress?: (ratio: number) => void,
): Promise<void> {
  const chunks = chunkTerminalInput(bytes);
  if (chunks.length === 0) {
    onProgress?.(1);
    return;
  }
  let sent = 0;
  for (const chunk of chunks) {
    transport.write(chunk);
    sent += chunk.byteLength;
    onProgress?.(sent / bytes.byteLength);
    if (sent < bytes.byteLength) await nextFrame();
  }
}
