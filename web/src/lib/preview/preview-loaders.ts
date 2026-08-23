/**
 * Turning a host file into something the browser can show.
 *
 * Three shapes, decided by the registry: text is decoded to a string, anything
 * the browser draws natively becomes an object URL over the real bytes, and
 * everything else is rendered to a PNG by the host and becomes an object URL
 * over that.
 *
 * All three drain their stream to completion or abort it. Half-draining a host
 * stream leaves it parked for a full minute holding one of the daemon's eight
 * long-task permits, which reads and writes are queueing behind.
 */

import type { HostControlClient, HostDirEntry } from "@/lib/hostControl";
import type { FileTypeInfo } from "@/lib/preview/file-kinds";
import { isTextKind, PREVIEW_BUDGET } from "@/lib/preview/file-kinds";
import {
  createPreviewObjectUrl,
  type PreviewLoader,
  type PreviewLoaderContext,
  type PreviewReady,
  type PreviewVariant,
} from "@/lib/preview/preview-cache";
import { decodeText, looksBinary } from "@/lib/preview/text-decode";

type Ready = Omit<PreviewReady, "status">;

/** Progress is reported per chunk group, not per 8 KiB frame. */
const PROGRESS_STEP_BYTES = 64 * 1024;

async function drain(
  stream: ReadableStream<Uint8Array>,
  total: number,
  context: PreviewLoaderContext,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let announced = 0;
  try {
    for (;;) {
      if (context.signal.aborted) {
        await reader.cancel("superseded");
        throw abortError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (received - announced >= PROGRESS_STEP_BYTES) {
        announced = received;
        context.onProgress(received, total);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * `bytes` is always freshly allocated at its exact length by `drain`, so its
 * backing buffer is the whole payload and no copy is needed to hand it over.
 */
function toBlob(bytes: Uint8Array, type: string): Blob {
  return new Blob([bytes.buffer as ArrayBuffer], { type });
}

function abortError() {
  return Object.assign(new Error("Preview superseded"), { code: "aborted" });
}

/**
 * Build the loader for one file.
 *
 * `variant` decides how much is worth fetching: a hover peek takes the head of
 * a text file and a small thumbnail, while the viewer takes the whole thing.
 */
export function makePreviewLoader(options: {
  client: HostControlClient;
  entry: Pick<HostDirEntry, "name" | "path" | "size" | "kind">;
  info: FileTypeInfo;
  variant: PreviewVariant;
  canQuicklook: boolean;
}): PreviewLoader {
  const { client, entry, info, variant, canQuicklook } = options;

  return async (context): Promise<Ready> => {
    if (info.kind === "none") {
      throw Object.assign(new Error("Nothing to preview"), { code: "preview_unsupported" });
    }

    if (isTextKind(info.kind)) {
      return loadText(client, entry, info, variant, context);
    }

    if (info.kind === "quicklook") {
      if (!canQuicklook) {
        throw Object.assign(new Error("This host cannot render previews"), {
          code: "preview_unsupported",
        });
      }
      return loadThumbnail(client, entry.path, variant, context);
    }

    return loadNative(client, entry, info, context);
  };
}

async function loadText(
  client: HostControlClient,
  entry: Pick<HostDirEntry, "name" | "path" | "size">,
  info: FileTypeInfo,
  variant: PreviewVariant,
  context: PreviewLoaderContext,
): Promise<Ready> {
  const size = entry.size ?? null;
  const limit = variant === "full" ? PREVIEW_BUDGET.textDecode : PREVIEW_BUDGET.hoverText;

  if (size !== null && size > info.maxBytes && variant === "full") {
    throw Object.assign(new Error("File is too large to display"), { code: "too_large" });
  }

  // `readHead` reads whole when it can and uses a real ranged read otherwise;
  // it never cancels a whole-file read to fake a head, because the cancel
  // tombstones that leaves behind can take the control channel down.
  const head = await client.readHead(entry.path, limit, { size, signal: context.signal });
  if (context.signal.aborted) throw abortError();

  if (looksBinary(head.bytes)) {
    throw Object.assign(new Error("This file is not text"), { code: "not_text" });
  }
  const decoded = decodeText(head.bytes, {
    partial: head.truncated,
    maxBytes: limit,
    maxLines: variant === "full" ? 5000 : 200,
  });
  return {
    mime: info.mime,
    bytes: head.bytes.byteLength,
    url: null,
    text: decoded.text,
    truncated: decoded.truncated || head.truncated,
  };
}

async function loadNative(
  client: HostControlClient,
  entry: Pick<HostDirEntry, "name" | "path" | "size">,
  info: FileTypeInfo,
  context: PreviewLoaderContext,
): Promise<Ready> {
  const size = entry.size ?? 0;
  if (size > info.maxBytes) {
    throw Object.assign(new Error("File is too large to preview inline"), { code: "too_large" });
  }
  const read = await client.readFile(entry.path, { signal: context.signal });
  const bytes = await drain(read.stream, read.length, context);
  // The daemon sends no content type, so the registry's is the only one there
  // is — and it is what decides whether <video> or <img> will even try.
  const url = createPreviewObjectUrl(toBlob(bytes, info.mime));
  return {
    mime: info.mime,
    bytes: bytes.byteLength,
    url,
    text: null,
    truncated: false,
  };
}

async function loadThumbnail(
  client: HostControlClient,
  path: string,
  variant: PreviewVariant,
  context: PreviewLoaderContext,
): Promise<Ready> {
  const size = variant === "full" ? PREVIEW_BUDGET.thumbPx.modal : PREVIEW_BUDGET.thumbPx.hover;
  const preview = await client.previewImage(path, size, { signal: context.signal });
  const bytes = await drain(preview.stream, preview.length, context);
  const url = createPreviewObjectUrl(toBlob(bytes, preview.mime));
  return {
    mime: preview.mime,
    bytes: bytes.byteLength,
    url,
    text: null,
    truncated: false,
    width: preview.width,
    height: preview.height,
  };
}
