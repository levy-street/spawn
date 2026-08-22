import * as ExpoCrypto from "expo-crypto";
import { Directory, File, type FileHandle, Paths } from "expo-file-system";
import { Share } from "react-native";
import type { VerifiedFileSink } from "@/components/files/transfer";

const DOWNLOADS_DIRECTORY = "spawn-downloads";

export function safeLocalFileName(name: string): string {
  const sanitized = Array.from(name, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f || char === "/" || char === "\\" || char === ":"
      ? "-"
      : char;
  })
    .join("")
    .trim();
  return sanitized.length > 0 ? sanitized.slice(0, 160) : "download";
}

export interface LocalDownload {
  file: File;
  sink: VerifiedFileSink;
}

export function createLocalDownload(name: string): LocalDownload {
  const directory = new Directory(Paths.cache, DOWNLOADS_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  const id = ExpoCrypto.randomUUID();
  const file = new File(directory, `${id}-${safeLocalFileName(name)}.partial`);
  file.create({ overwrite: false, intermediates: true });
  let handle: FileHandle | null = file.open();
  let committed = false;
  const close = () => {
    handle?.close();
    handle = null;
  };
  return {
    file,
    sink: {
      write(chunk) {
        if (!handle) throw new Error("Download file is closed.");
        handle.writeBytes(chunk);
      },
      commit() {
        close();
        file.rename(`${id}-${safeLocalFileName(name)}`);
        committed = true;
      },
      remove() {
        close();
        if (!committed && file.exists) file.delete();
      },
    },
  };
}

export async function shareLocalFile(file: File): Promise<void> {
  await Share.share({ title: file.name, url: file.uri });
}
