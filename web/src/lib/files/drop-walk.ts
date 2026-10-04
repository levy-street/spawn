/**
 * Files and folders from this device, as an upload's list: from a drop
 * (`DataTransferItem.webkitGetAsEntry`, which is how a dropped folder can be
 * walked at all) or from a folder picked with `<input webkitdirectory>`.
 *
 * Every file comes with its "/"-separated path under what was dropped, folder
 * names first ("site/css/a.css"), and folders that hold nothing are kept so
 * they are made on the host too.
 */

import { type LocalItem, MAX_TRANSFER_ITEMS } from "./transfer-plan";

interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}
interface FileEntryLike extends EntryLike {
  file(success: (file: File) => void, failure?: (error: unknown) => void): void;
}
interface DirectoryEntryLike extends EntryLike {
  createReader(): {
    readEntries(success: (entries: EntryLike[]) => void, failure?: (error: unknown) => void): void;
  };
}

export interface LocalPick {
  items: LocalItem[];
  emptyDirs: string[];
}

/**
 * What a drop carries, taken while the event still allows it: a drop's
 * `DataTransfer` is emptied once the handler returns, so call this from the
 * handler itself and walk afterwards.
 */
export function droppedEntries(dataTransfer: DataTransfer): {
  entries: EntryLike[];
  files: File[];
} {
  const entries: EntryLike[] = [];
  const loose: File[] = [];
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = (item as { webkitGetAsEntry?: () => EntryLike | null }).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) loose.push(file);
    }
  }
  // A browser without entries still hands over the files themselves.
  if (entries.length === 0 && loose.length === 0)
    loose.push(...Array.from(dataTransfer.files ?? []));
  return { entries, files: loose };
}

/** Walk dropped entries. Stops just past `limit` items: the upload refuses that many whole. */
export async function walkDropped(
  { entries, files }: { entries: readonly EntryLike[]; files: readonly File[] },
  limit = MAX_TRANSFER_ITEMS,
): Promise<LocalPick> {
  const pick: LocalPick = {
    items: files.map((file) => ({ rel: file.name, file })),
    emptyDirs: [],
  };
  const full = () => pick.items.length + pick.emptyDirs.length > limit;
  const visit = async (entry: EntryLike, prefix: string): Promise<void> => {
    if (full()) return;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileEntryLike).file(resolve, reject),
      );
      pick.items.push({ rel, file });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as DirectoryEntryLike).createReader();
    let any = false;
    // readEntries answers in batches (a hundred at a time in Chromium) until empty.
    for (;;) {
      const batch = await new Promise<EntryLike[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      any = true;
      for (const child of batch) {
        await visit(child, rel);
        if (full()) return;
      }
    }
    if (!any) pick.emptyDirs.push(rel);
  };
  for (const entry of entries) {
    await visit(entry, "");
    if (full()) break;
  }
  return pick;
}

/** A folder picked with `<input webkitdirectory>`: each file knows its path under it. */
export function pickedFolder(files: readonly File[]): LocalPick {
  return {
    items: files.map((file) => ({
      rel: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      file,
    })),
    emptyDirs: [],
  };
}
