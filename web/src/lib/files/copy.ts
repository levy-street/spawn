/**
 * What the file browser says. The meaning of every string here is shared with
 * the phone's file browser (mobile/src/components/files), so a change here is
 * a change there in the same commit. Every sentence about a host names it;
 * the product is only ever "SPAWN D".
 *
 * Pure and DOM-free.
 */

import { HOST_DIRECTORY_ENTRY_CAP } from "./listing";
import type { SortKey, SortOrder } from "./sort";

/** When a host's name is not known yet. */
export const UNNAMED_HOST = "this host";

export const FILTER_PLACEHOLDER = "Filter this folder";
export const SHOW_HIDDEN_LABEL = "Show hidden files";
export const HIDE_HIDDEN_LABEL = "Hide hidden files";
export const FOLDERS_ON_TOP_LABEL = "Folders on top";
export const NEW_FOLDER_LABEL = "New folder";
export const NEW_FILE_LABEL = "New file";
export const UPLOAD_FILES_LABEL = "Upload files…";
export const GO_TO_FOLDER_LABEL = "Go to folder";
/**
 * The live indicator on a host that is polled rather than watched. Said only
 * of a folder that fits on one page: a bigger one is not kept up to date on a
 * timer, it says when it has changed (`changedOnHostNotice`).
 */
export const POLLED_REFRESH_NOTE = "Refreshes every few seconds";

export const EMPTY_FOLDER = "This folder is empty.";

function count(n: number): string {
  return n.toLocaleString("en-US");
}

export function itemCount(n: number): string {
  return `${count(n)} ${n === 1 ? "item" : "items"}`;
}

function plural(n: number, one: string, many: string): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/** Nothing shows, and only because the hidden toggle is keeping it back. */
export function onlyHiddenFiles(hidden: number): string {
  return `This folder has only hidden files (${count(hidden)}).`;
}

/** The filter found nothing shown; say so, and how many hidden files it would. */
export function noFilterMatches(query: string, hiddenMatches = 0): string {
  const base = `Nothing in this folder matches “${query.trim()}”.`;
  return hiddenMatches > 0
    ? `${base} ${plural(hiddenMatches, "hidden file matches", "hidden files match")}.`
    : base;
}

/**
 * Page one of a folder bigger than one page moved on the host. Its other pages
 * are read again only on Refresh, so the rows on screen are as last read.
 */
export function changedOnHostNotice(host: string): string {
  return `This folder changed on ${host}.`;
}

/** The two directions of a sort, in the words that fit its field. */
export const SORT_ORDER_LABELS: Readonly<Record<SortKey, Readonly<Record<SortOrder, string>>>> = {
  name: { asc: "A to Z", desc: "Z to A" },
  modified: { desc: "Newest first", asc: "Oldest first" },
  size: { desc: "Largest first", asc: "Smallest first" },
  kind: { asc: "A to Z", desc: "Z to A" },
};

/**
 * A folder the host stopped listing at its cap. Honest about what the order
 * covers: everything shown is sorted, but the rest was never seen.
 */
export function truncationNotice(host: string): string {
  const cap = count(HOST_DIRECTORY_ENTRY_CAP);
  return `This folder has more than ${cap} items. SPAWN D on ${host} can only list the first ${cap} it finds, so sorting and filtering cover just those.`;
}

/** The tree's one-line version, under a folder the host cut short; the full notice is its tooltip. */
export const TRUNCATED_ROW_LABEL = `Only the first ${count(HOST_DIRECTORY_ENTRY_CAP)} items are shown`;

/** Why a folder could not be opened, from the host's own error code. */
export function listErrorCopy(code: string | null | undefined, host: string): string | null {
  switch (code) {
    case "outside_root":
    case "traversal_rejected":
      return `SPAWN D only opens folders inside your home folder on ${host}.`;
    case "not_found":
      return `There's no folder at that path on ${host}.`;
    case "symlink_rejected":
      return "That path goes through a link SPAWN D doesn't follow.";
    case "not_directory":
      return `That's a file on ${host}, not a folder.`;
    case "permission_denied":
      return `SPAWN D on ${host} isn't allowed to open that folder.`;
    default:
      return null;
  }
}

/** Why a change (new, rename, delete) did not happen, from the host's code. */
export function changeErrorCopy(
  code: string | null | undefined,
  { host, name }: { host: string; name: string },
): string | null {
  switch (code) {
    case "already_exists":
      return `There's already an item named “${name}” here.`;
    case "invalid_name":
    case "invalid_path":
      return `“${name}” can't be used as a name on ${host}.`;
    case "permission_denied":
      return `SPAWN D on ${host} isn't allowed to change “${name}”.`;
    case "root_protected":
      return "Your home folder can't be renamed or deleted.";
    case "not_found":
      return `“${name}” is no longer there on ${host}.`;
    case "symlink_rejected":
      return "That path goes through a link SPAWN D doesn't follow.";
    // The host could not say why, but a look afterwards showed nothing moved
    // (change-check.ts): this is not the lost-touch case below.
    case "unchanged":
      return `SPAWN D couldn't change this on ${host}.`;
    // Only when not even a look afterwards could settle it.
    case "outcome_unknown":
      return `SPAWN D lost touch with ${host} before it answered, so this may or may not have happened. Check the folder before trying again.`;
    default:
      return null;
  }
}

export interface DeleteConfirmCopy {
  title: string;
  body: string;
  confirmLabel: string;
}

/**
 * Deleting is permanent until hosts can move things to the Trash (OD10), so
 * the dialog says exactly that, and names what is going.
 */
export function deleteConfirmCopy(
  items: ReadonlyArray<{ name: string; isDir: boolean }>,
  host: string,
): DeleteConfirmCopy {
  const confirmLabel = "Delete permanently";
  const only = items.length === 1 ? items[0] : undefined;
  const folders = items.some((item) => item.isDir)
    ? only
      ? " Everything inside the folder goes with it."
      : " Folders go with everything inside them."
    : "";
  return {
    title: only
      ? `Delete “${only.name}” permanently?`
      : `Delete ${count(items.length)} items permanently?`,
    body: `${only ? "It" : "They"} won't go to the Trash on ${host}.${folders} This can't be undone.`,
    confirmLabel,
  };
}

/** The menu item that asks for that confirm. */
export const DELETE_PERMANENTLY_LABEL = "Delete permanently…";

/** While a delete runs: it goes item by item, and a folder can take a while. */
export function deletingNotice(names: readonly string[], host: string): string {
  return names.length === 1
    ? `Deleting “${names[0]}” on ${host}…`
    : `Deleting ${itemCount(names.length)} on ${host}…`;
}

export function deletedNotice(names: readonly string[], host: string): string {
  return names.length === 1
    ? `Deleted “${names[0]}” on ${host}`
    : `Deleted ${itemCount(names.length)} on ${host}`;
}

/** Some of several went. What stayed stays selected, ready for another try. */
export function partialDeleteNotice(
  deleted: number,
  total: number,
  host: string,
  firstFailure: { name: string; reason: string },
): string {
  return `Deleted ${count(deleted)} of ${itemCount(total)} on ${host}. “${firstFailure.name}” wasn't deleted: ${firstFailure.reason}`;
}

/**
 * "142 items · 3 hidden · 2 selected, 12.4 MB" — the status bar's left half.
 * `shown` is the rows on screen at the folder's own level (after the hidden
 * toggle and the filter), `hidden` the hidden names the filter would show:
 * the phone's count line says the same two numbers.
 */
export function statusSummary({
  shown,
  hidden,
  selected,
  selectedBytes,
  formatBytes,
}: {
  shown: number;
  hidden: number;
  selected: number;
  /** Bytes in the selected files; null when nothing selected has a size. */
  selectedBytes: number | null;
  formatBytes: (bytes: number) => string;
}): string {
  const parts = [itemCount(shown)];
  if (hidden > 0) parts.push(`${count(hidden)} hidden`);
  if (selected > 0) {
    parts.push(
      selectedBytes === null
        ? `${count(selected)} selected`
        : `${count(selected)} selected, ${formatBytes(selectedBytes)}`,
    );
  }
  return parts.join(" · ");
}
