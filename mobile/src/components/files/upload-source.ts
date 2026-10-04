import { File, type FileHandle, Paths } from "expo-file-system";
import type { HostFileSource } from "@/terminal/transport/types";

/**
 * How much of a picked file is read from flash at a time. The host stream
 * takes it 8 KiB at a time, twice over (once to fingerprint it, once to send
 * it), and one native call per 8 KiB of a 512 MiB file is 65,536 calls a pass.
 */
export const LOCAL_READ_AHEAD_BYTES = 256 * 1024;

/** A file on the phone, read in order, a piece at a time, never whole into memory. */
export interface LocalFileSource extends HostFileSource {
  close(): void;
}

/**
 * Opens a file the picker copied into the app's cache. Reads go through one
 * read-ahead buffer: the upload reads the file from the start twice, so a
 * read before the buffer, or past it, moves the handle and refills it. A read
 * that comes back short — the file shrank — is handed back short, and the
 * transport refuses it as a file that changed while it was read.
 */
export function openLocalFileSource(
  uri: string,
  readAhead = LOCAL_READ_AHEAD_BYTES,
): LocalFileSource {
  const file = new File(uri);
  const size = file.size;
  let handle: FileHandle | null = file.open();
  let buffer = new Uint8Array(0);
  let bufferStart = 0;
  return {
    size,
    async read(offset, length) {
      if (!handle) throw new Error("The picked file is closed.");
      if (offset < bufferStart || offset + length > bufferStart + buffer.byteLength) {
        handle.offset = offset;
        buffer = handle.readBytes(Math.max(length, readAhead));
        bufferStart = offset;
      }
      const start = offset - bufferStart;
      return buffer.slice(start, start + length);
    },
    close() {
      handle?.close();
      handle = null;
      buffer = new Uint8Array(0);
    },
  };
}

/**
 * Deletes the picker's copy of a file once nothing will read it again. Only a
 * copy inside the app's own cache is ever deleted; anything else is the
 * phone's and is left alone.
 */
export function releaseLocalCopy(uri: string): void {
  try {
    const root = Paths.cache.uri;
    const cache = root.endsWith("/") ? root : `${root}/`;
    if (!uri.startsWith(cache) || uri.includes("/../")) return;
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // The cache is the system's to clear in the end; a copy left behind costs nothing more.
  }
}
