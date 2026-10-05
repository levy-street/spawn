import { HOST_DIRECTORY_SCAN_LIMIT } from "@/components/files/pagination";
import type { HostDirEntry } from "@/components/files/types";

/**
 * The explorer's words. The web explorer says the same things in its own
 * layout (root CLAUDE.md), and every sentence that is about a host names it.
 */

export const FILTER_PLACEHOLDER = "Filter this folder";
export const SHOW_HIDDEN_LABEL = "Show hidden files";
export const HIDE_HIDDEN_LABEL = "Hide hidden files";
export const FOLDERS_ON_TOP_LABEL = "Folders on top";

const SCAN_LIMIT = HOST_DIRECTORY_SCAN_LIMIT.toLocaleString("en-US");

/**
 * Honest about what a v1 host can list. There is no newer SPAWN D that lists
 * more yet, so this does not tell anyone to update; it says what the order and
 * the filter can and cannot see.
 */
export function truncatedFolderNotice(hostName: string): string {
  return `This folder has more than ${SCAN_LIMIT} items. SPAWN D on ${hostName} can only list the first ${SCAN_LIMIT} it finds, so sorting and filtering cover just those.`;
}

export function changedOnHostNotice(hostName: string): string {
  return `This folder changed on ${hostName}.`;
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** "142 items" under the list, and how many the hidden toggle is keeping back. */
export function folderCountLabel(shown: number, hiddenKeptBack: number): string {
  const items = plural(shown, "item", "items");
  return hiddenKeptBack > 0 ? `${items} · ${hiddenKeptBack.toLocaleString("en-US")} hidden` : items;
}

export function selectionCountLabel(count: number): string {
  return count === 0 ? "Select items" : `${count.toLocaleString("en-US")} selected`;
}

export function deleteConfirmTitle(entries: readonly Pick<HostDirEntry, "name">[]): string {
  const only = entries.length === 1 ? entries[0] : undefined;
  return only
    ? `Delete “${only.name}” permanently?`
    : `Delete ${plural(entries.length, "item", "items")} permanently?`;
}

/** There is no Trash on the wire yet, so every delete is the permanent one, and says so. */
export function deleteConfirmDescription(
  entries: readonly Pick<HostDirEntry, "is_dir">[],
  hostName: string,
): string {
  const subject = entries.length === 1 ? "It" : "They";
  const folders = entries.some((entry) => entry.is_dir)
    ? entries.length === 1
      ? " Everything inside the folder goes with it."
      : " Folders go with everything inside them."
    : "";
  return `${subject} won't go to the Trash on ${hostName}.${folders} This can't be undone.`;
}

export const DELETE_PERMANENTLY = "Delete permanently";
/** A menu's delete says what it does while there is no Trash; the confirm that follows says it again. */
export const DELETE_PERMANENTLY_MENU = "Delete permanently…";

/** While a delete runs, in the folder's notice line: there is nothing to cancel, so nothing offers to. */
export function deletingNotice(
  entries: readonly Pick<HostDirEntry, "name">[],
  hostName: string,
): string {
  const only = entries.length === 1 ? entries[0] : undefined;
  return only
    ? `Deleting “${only.name}” on ${hostName}…`
    : `Deleting ${plural(entries.length, "item", "items")} on ${hostName}…`;
}

export function deletedNotice(names: readonly string[], hostName: string): string {
  return names.length === 1
    ? `Deleted “${names[0]}” on ${hostName}`
    : `Deleted ${plural(names.length, "item", "items")} on ${hostName}`;
}

export function partialDeleteMessage(
  deleted: number,
  total: number,
  hostName: string,
  firstFailure: { name: string; reason: string },
): string {
  return `Deleted ${deleted.toLocaleString("en-US")} of ${plural(total, "item", "items")} on ${hostName}. “${firstFailure.name}” wasn't deleted: ${firstFailure.reason}`;
}

export function emptyFolderDescription(showHidden: boolean, hiddenKeptBack: number): string {
  if (showHidden || hiddenKeptBack === 0) return "This folder is empty.";
  return `This folder has only hidden files (${hiddenKeptBack.toLocaleString("en-US")}).`;
}

export function noMatchesDescription(query: string, hiddenMatches: number): string {
  const base = `Nothing in this folder matches “${query.trim()}”.`;
  return hiddenMatches > 0
    ? `${base} ${plural(hiddenMatches, "hidden file matches", "hidden files match")}.`
    : base;
}
