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

// ---- Transfers ----------------------------------------------------------------
//
// Uploads, downloads and sends between hosts all run in the Transfers tray.
// Every sentence names the host; "this device" is the browser itself.

export const SEND_TO_HOST_LABEL = "Send to another host…";
export const SEND_PICK_HOST_TITLE = "Send to which host?";
/** The host step with nothing to pick. */
export const SEND_NO_OTHER_HOST = "There's no other host to send to. Add one from Hosts.";
/** A host in that step it can't send to now. */
export const SEND_HOST_OFFLINE = "Offline";
export const CHANGE_FOLDER_LABEL = "Change folder…";

/** The folder step of a send: the browser on the host picked. */
export function sendFolderTitle(host: string): string {
  return `Where on ${host}?`;
}
export const DOWNLOAD_LABEL = "Download";
export const DOWNLOAD_ZIP_LABEL = "Download as zip";
export const UPLOAD_FOLDER_LABEL = "Upload folder…";
export const OPEN_TERMINAL_HERE_LABEL = "Open terminal here";
export const START_AGENT_HERE_LABEL = "Start agent here…";
export const PERMISSIONS_NOT_COPIED = "Permissions aren't copied between hosts.";
export const TRANSFERS_TITLE = "Transfers";
export const CLEAR_FINISHED_LABEL = "Clear finished";
export const RESUME_LABEL = "Resume";
export const RETRY_LABEL = "Retry";
export const CANCEL_TRANSFER_LABEL = "Cancel";
export const BEFORE_UNLOAD_TRANSFERS = "Transfers are still running. Leave anyway?";

/** "Download 3 items as zip": a selection of several always goes as one archive. */
export function downloadItemsLabel(n: number): string {
  return `Download ${itemCount(n)} as zip`;
}

/** The Send dialog's title, and its button. */
export function sendTitle(names: readonly string[], host: string): string {
  return names.length === 1
    ? `Send “${names[0]}” to ${host}`
    : `Send ${itemCount(names.length)} to ${host}`;
}

/** Where a send lands, under the dialog's title. */
export function sendDestinationLine(folder: string, host: string): string {
  return `Into ${folder} on ${host}`;
}

export const CONFLICT_POLICY_LABEL = "If an item is already there";

/** The four ways a send can treat a name already taken, worded the same on the phone. */
export const CONFLICT_POLICY_COPY = {
  ask: { label: "Ask each time", detail: "Nothing already there changes without your say" },
  "keep-both": { label: "Keep both", detail: "What you send gets a new name, like “notes (2).md”" },
  replace: {
    label: "Replace",
    detail: "Files with the same name are replaced, and folders merged",
  },
  skip: { label: "Skip", detail: "Anything already there is left as it is" },
} as const;

/** "about 20 seconds", "about 3 minutes", "about 2 hours". */
export function formatDuration(seconds: number): string {
  if (seconds < 90) {
    const rounded = Math.max(5, Math.round(seconds / 5) * 5);
    return `about ${rounded} seconds`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(seconds / 3600);
  return `about ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/** The tray's estimate, said only past ESTIMATE_AFTER_SECONDS. */
export function timeLeft(seconds: number): string {
  return `${formatDuration(seconds)} left`;
}

export type TransferVerb = "upload" | "send" | "download";

const VERB = {
  upload: { doing: "Uploading", done: "Uploaded", past: "uploaded", anyway: "Upload anyway" },
  send: { doing: "Sending", done: "Sent", past: "sent", anyway: "Send anyway" },
  download: {
    doing: "Downloading",
    done: "Downloaded",
    past: "downloaded",
    anyway: "Download anyway",
  },
} as const;

/**
 * One transfer, as the tray names it: "Uploading 12 items to Documents on
 * dream", "Sent “a.txt” from dream to Home on mac-mini". Once it is done the
 * title is the notice that it arrived.
 */
export function transferTitle({
  verb,
  names,
  from,
  to,
  folder,
  finished,
}: {
  verb: TransferVerb;
  /** What was picked (one name is quoted; several are counted). */
  names: readonly string[];
  /** The host it comes from (sends and downloads). */
  from?: string;
  /** The host it goes to (uploads and sends). */
  to?: string;
  /** The folder there it goes into: "Documents", "Home". */
  folder?: string;
  finished: boolean;
}): string {
  const what = names.length === 1 ? `“${names[0]}”` : itemCount(names.length);
  const lead = finished ? VERB[verb].done : VERB[verb].doing;
  const into = folder ? `${folder} on ${to}` : to;
  if (verb === "upload") return `${lead} ${what} to ${into}`;
  if (verb === "download") return `${lead} ${what} from ${from}`;
  return `${lead} ${what} from ${from} to ${into}`;
}

/** The relay warning's proceed button. */
export function proceedAnywayLabel(verb: TransferVerb): string {
  return VERB[verb].anyway;
}

/**
 * OD3, before a relayed transfer of more than 100 MB. `hosts` are the ones
 * reached through the relay; `estimate` is said only when it is worth saying.
 */
export function relayWarning({
  hosts,
  bytes,
  estimate,
  formatBytes,
}: {
  hosts: readonly string[];
  bytes: number;
  estimate: number | null;
  formatBytes: (bytes: number) => string;
}): string {
  const who =
    hosts.length === 1
      ? `${hosts[0]} and this device can't reach each other directly`
      : `this device can't reach ${hosts.slice(0, -1).join(", ")} or ${hosts.at(-1)} directly`;
  const time = estimate !== null ? ` It will take ${formatDuration(estimate)}.` : "";
  return `This transfer goes through the SPAWN D relay because ${who}. ${formatBytes(bytes)} may take a while.${time}`;
}

/** "“notes.md” already exists in Documents on mac-mini." */
export function conflictQuestion({
  name,
  isDir,
  folder,
  host,
}: {
  name: string;
  isDir: boolean;
  folder: string;
  host: string;
}): string {
  return isDir
    ? `A folder named “${name}” already exists in ${folder} on ${host}.`
    : `“${name}” already exists in ${folder} on ${host}.`;
}

/** The conflict answers. On a folder, Replace merges, and says so. */
export function conflictDecisionLabel(
  decision: "replace" | "keep-both" | "skip",
  isDir: boolean,
): string {
  if (decision === "replace") return isDir ? "Merge" : "Replace";
  return decision === "keep-both" ? "Keep both" : "Skip";
}

export function applyToOthersLabel(others: number): string {
  return `Do this for the other ${count(others)}`;
}

/** Why a transfer stopped part-way, with Resume beside it. */
export function interruptedNotice(cause: "other-tab" | "lost-touch", host: string): string {
  return cause === "other-tab"
    ? "Interrupted because another SPAWN D tab closed or went to sleep."
    : `Interrupted because SPAWN D lost touch with ${host}.`;
}

export function queuedNotice(host: string): string {
  return `Waiting for another transfer with ${host} to finish`;
}

export function countingNotice(host: string, counted: number): string {
  return counted > 0
    ? `Counting items on ${host}… ${count(counted)} so far`
    : `Counting items on ${host}…`;
}

export const PREPARING_NOTICE = "Preparing…";

/** A big file is read once on this device to fingerprint it before a byte is sent. */
export function preparingNotice(percent: number): string {
  return `${PREPARING_NOTICE} ${Math.max(0, Math.min(100, Math.round(percent)))}%`;
}

/** "12.4 MB of 1.2 GB · 3 of 12 items · about 2 minutes left" */
export function transferProgress({
  doneBytes,
  totalBytes,
  doneItems,
  totalItems,
  secondsLeft,
  formatBytes,
}: {
  doneBytes: number;
  totalBytes: number;
  doneItems: number;
  totalItems: number;
  secondsLeft: number | null;
  formatBytes: (bytes: number) => string;
}): string {
  const parts = [`${formatBytes(doneBytes) || "0 B"} of ${formatBytes(totalBytes) || "0 B"}`];
  if (totalItems > 1) parts.push(`${count(doneItems)} of ${itemCount(totalItems)}`);
  if (secondsLeft !== null) parts.push(timeLeft(secondsLeft));
  return parts.join(" · ");
}

/** A finished transfer: "12 items · 1.2 GB · 2 skipped". */
export function transferDoneSummary({
  items,
  bytes,
  skipped,
  formatBytes,
}: {
  items: number;
  bytes: number;
  skipped: number;
  formatBytes: (bytes: number) => string;
}): string {
  const parts = [itemCount(items), formatBytes(bytes) || "0 B"];
  if (skipped > 0) parts.push(`${count(skipped)} skipped`);
  return parts.join(" · ");
}

/** "3 items couldn't be sent." */
export function transferFailedSummary(failed: number, verb: TransferVerb): string {
  return `${itemCount(failed)} couldn't be ${VERB[verb].past}.`;
}

export const TRANSFER_CANCELLED = "Cancelled";
export const HIDE_TRANSFERS_LABEL = "Hide transfers";

/** The tray's one line, collapsed: what needs the person first, then how far things are. */
export function transfersSummary({
  waiting,
  active,
  percent,
}: {
  /** Transfers asking a question or stopped part-way. */
  waiting: number;
  /** Transfers not finished. */
  active: number;
  /** How far the active ones are, by bytes, when known. */
  percent: number | null;
}): string {
  if (waiting > 0)
    return waiting === 1 ? "1 transfer needs you" : `${count(waiting)} transfers need you`;
  if (active === 0) return "Transfers done";
  const what = active === 1 ? "1 transfer" : `${count(active)} transfers`;
  return percent === null ? what : `${what} · ${percent}%`;
}

/** The ✕ on a finished transfer; the row it sits in names the transfer. */
export const REMOVE_TRANSFER_LABEL = "Remove from the list";

export function linksSkippedNote(n: number): string {
  return n === 1 ? "1 link was skipped." : `${count(n)} links were skipped.`;
}

export function specialFilesSkippedNote(n: number): string {
  return n === 1
    ? "1 item that isn't a file or folder was skipped."
    : `${count(n)} items that aren't files or folders were skipped.`;
}

/**
 * Folders in a transfer that the host stopped listing at its cap — said the
 * way the file list says it about a folder on screen.
 */
export function truncatedFolderNote(
  folders: readonly string[],
  host: string,
  verb: TransferVerb,
): string {
  const cap = count(HOST_DIRECTORY_ENTRY_CAP);
  const past = VERB[verb].past;
  return folders.length === 1
    ? `“${folders[0]}” has more than ${cap} items. SPAWN D on ${host} can only list the first ${cap}, so only those are ${past}.`
    : `${count(folders.length)} folders have more than ${cap} items. SPAWN D on ${host} can only list the first ${cap} in each, so only those are ${past}.`;
}

/** A folder past MAX_TRANSFER_ITEMS: refused whole, never sent in part. */
export function tooManyItemsNotice(name: string, limit: number): string {
  return `“${name}” holds more than ${count(limit)} items. Pick a smaller folder.`;
}

/** The name a folder download is saved under. */
export function archiveName(names: readonly string[], folder: string | null): string {
  const base = names.length === 1 ? names[0] : folder || "Files";
  return `${base}.zip`;
}

/**
 * A browser with no streaming way to save (no save picker, no service worker
 * yet) holds a download in memory, and only so much of it.
 */
export function downloadTooLargeNotice(limit: string): string {
  return `This browser can only save up to ${limit} at a time from SPAWN D. Reload the page and try again, or use Chrome or Edge.`;
}

/** The browser's own download of a streamed file was stopped (cancelled there, or it gave up). */
export function browserStoppedSaving(name: string): string {
  return `The browser stopped saving “${name}”.`;
}

/** A host without ranged reads can only start a file again, and a download can't take bytes back. */
export function cantResumeNotice(host: string): string {
  return `SPAWN D on ${host} can't pick a download up part-way. Download it again.`;
}

/**
 * Why one item of a transfer did not make it, from the host's (or browser's)
 * code. `side` says which end answered: a send reads from one host and writes
 * to the other, and the sentence names the one that said no. `folder` is the
 * folder a write was going into ("Documents", "Home").
 */
export function transferErrorCopy(
  code: string | null | undefined,
  {
    host,
    name,
    side,
    folder,
  }: { host: string; name: string; side: "read" | "write" | "local"; folder?: string },
): string | null {
  const into = folder || "that folder";
  switch (code) {
    case "file_too_large":
      return `“${name}” is larger than 512 MB, the most SPAWN D can move in one file.`;
    case "permission_denied":
      return side === "write"
        ? `SPAWN D on ${host} isn't allowed to write to ${into}.`
        : `SPAWN D on ${host} isn't allowed to read “${name}”.`;
    case "not_found":
      return side === "write"
        ? `${folder || "That folder"} is no longer there on ${host}.`
        : `“${name}” is no longer there on ${host}.`;
    case "already_exists":
      return `“${name}” already exists in ${into} on ${host}.`;
    case "invalid_name":
    case "invalid_path":
      return `“${name}” can't be used as a name on ${host}.`;
    case "symlink_rejected":
      return "That path goes through a link SPAWN D doesn't follow.";
    case "not_file":
    case "not_directory":
      return `“${name}” isn't a regular file on ${host}.`;
    case "file_changed":
    case "version_changed":
      return `“${name}” changed while it was being copied. Try again.`;
    case "integrity_mismatch":
    case "length_mismatch":
      return side === "write"
        ? `“${name}” didn't arrive intact on ${host}, so it wasn't kept. Try again.`
        : `“${name}” didn't arrive intact from ${host}, so it wasn't kept. Try again.`;
    case "unsupported_operation":
    case "streaming_unsupported":
    case "capabilities_unavailable":
      return side === "write"
        ? `SPAWN D on ${host} can't receive files.`
        : `SPAWN D on ${host} can't send files.`;
    case "local_unreadable":
      return `“${name}” couldn't be read on this device. Pick it again to upload it.`;
    case "outcome_unknown":
      return `SPAWN D lost touch with ${host} before it answered, so “${name}” may or may not have arrived. Check the folder before trying again.`;
    case "io_error":
      return side === "write"
        ? `${host} couldn't write “${name}”.`
        : `${host} couldn't read “${name}”.`;
    default:
      return null;
  }
}
