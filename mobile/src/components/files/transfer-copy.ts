import { formatFileSize } from "@/components/files/format";
import { HOST_DIRECTORY_SCAN_LIMIT } from "@/components/files/pagination";
import type { ConflictDecision, ConflictPolicy } from "@/components/files/transfer-plan";
import type { TransferInterruption } from "@/data/stores/transfers";

/**
 * The words of uploads, sends and the Transfers sheet. The web file browser
 * says the same things in its own layout (web/src/lib/files/copy.ts, and the
 * root CLAUDE.md): every sentence about a host names it, and the product is
 * only ever "SPAWN D".
 */

export const UPLOAD_FROM_FILES = "Upload from Files…";
export const UPLOAD_FROM_PHOTOS = "Upload from Photos…";
export const SEND_TO_ANOTHER_HOST = "Send to another host…";
/** The selection bar's short label; its accessibility label is {@link SEND_TO_ANOTHER_HOST}. */
export const SEND_SELECTION = "Send…";
export const OPEN_TERMINAL_HERE = "Open terminal here";
export const START_AGENT_HERE = "Start agent here…";
export const DOWNLOAD_AND_SHARE = "Download & Share…";
/** No streaming archive yet, so a folder is said not to download rather than half-done. */
export const FOLDER_DOWNLOAD_UNAVAILABLE = "Folders can't be downloaded on the phone yet.";
/** Unchanged from the single-file download: the phone's connection lives with the app. */
export const KEEP_OPEN = "Keep SPAWN D open until transfer finishes.";
export const PERMISSIONS_NOT_COPIED = "Permissions aren't copied between hosts.";
export const TRANSFERS_TITLE = "Transfers";
export const CONFLICT_POLICY_LABEL = "If an item is already there";
export const RESUME = "Resume";
export const CLEAR_FINISHED = "Clear finished";
export const TRANSFER_CANCELLED = "Cancelled";
export const PREPARING = "Preparing…";
export const NO_OTHER_HOST = "There's no other host to send to. Add one from Hosts.";
/** What a resumed transfer does on the phone, where a v1 host cannot take a write back up. */
export const RESUME_DETAIL =
  "Resume sends what's left; a file that was cut off starts again from the beginning.";
export const PAUSED_TITLE = "Paused when SPAWN D went to the background";
export const PAUSED_DETAIL = `The phone closes its host connections a few seconds after SPAWN D leaves the screen. ${RESUME_DETAIL}`;
export const INTERRUPTED_ITEM = "Stopped when SPAWN D went to the background";

/** The four ways a send can treat a name already taken, worded the same on the web. */
export const CONFLICT_POLICY_COPY: Readonly<
  Record<ConflictPolicy, { label: string; detail: string }>
> = {
  ask: { label: "Ask each time", detail: "Nothing already there changes without your say" },
  keep_both: { label: "Keep both", detail: "What you send gets a new name, like “notes (2).md”" },
  replace: {
    label: "Replace",
    detail: "Files with the same name are replaced, and folders merged",
  },
  skip: { label: "Skip", detail: "Anything already there is left as it is" },
};

const SCAN_LIMIT = HOST_DIRECTORY_SCAN_LIMIT.toLocaleString("en-US");

function count(value: number): string {
  return value.toLocaleString("en-US");
}

export function itemsLabel(total: number): string {
  return `${count(total)} ${total === 1 ? "item" : "items"}`;
}

/** The send sheet's button: "Send “notes.md” to mac-mini", "Send 3 items to mac-mini". */
export function sendButtonLabel(names: readonly string[], hostName: string): string {
  return names.length === 1
    ? `Send “${names[0]}” to ${hostName}`
    : `Send ${itemsLabel(names.length)} to ${hostName}`;
}

export function sendDestinationTitle(hostName: string): string {
  return `Where on ${hostName}?`;
}

/** Where a send lands, under its title: "Into Documents on mac-mini", "Into Home on mac-mini". */
export function sendDestinationLine(folderLabel: string, hostName: string): string {
  return `Into ${folderLabel} on ${hostName}`;
}

export const SEND_PICK_HOST_TITLE = "Send to which host?";

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

/** The relay warning's proceed button: "Upload anyway", "Send anyway", "Download anyway". */
export function proceedAnywayLabel(verb: TransferVerb): string {
  return VERB[verb].anyway;
}

/**
 * Said before a relayed transfer over the warning size starts (OD3): which
 * host the device cannot reach directly, how much is going, and — when it is
 * worth saying — about how long it will take.
 */
export function relayWarning(
  relayed: readonly string[],
  totalBytes: number,
  estimate: number | null = null,
): string {
  const size = formatFileSize(totalBytes);
  const [first, second] = relayed;
  const why =
    second === undefined
      ? `${first} and this device can't reach each other directly`
      : `this device can't reach ${first} or ${second} directly`;
  const time = estimate === null ? "" : ` It will take ${formatDuration(estimate)}.`;
  return `This transfer goes through the SPAWN D relay because ${why}. ${size} may take a while.${time}`;
}

export function linksSkipped(links: number): string {
  return links === 1 ? "1 link was skipped." : `${count(links)} links were skipped.`;
}

export function specialSkipped(special: number): string {
  return special === 1
    ? "1 item that isn't a file or folder was skipped."
    : `${count(special)} items that aren't files or folders were skipped.`;
}

/** A folder the source host lists only in part: what is sent of it, said before sending. */
export function truncatedSendNotice(folders: readonly string[], hostName: string): string {
  const [only] = folders;
  return folders.length === 1
    ? `“${only}” has more than ${SCAN_LIMIT} items. SPAWN D on ${hostName} can only list the first ${SCAN_LIMIT}, so only those are sent.`
    : `${count(folders.length)} folders have more than ${SCAN_LIMIT} items. SPAWN D on ${hostName} can only list the first ${SCAN_LIMIT} in each, so only those are sent.`;
}

/** A pick past the item limit: refused whole, never sent in part. */
export function tooManyItems(name: string, limit: number): string {
  return `“${name}” holds more than ${count(limit)} items. Pick a smaller folder.`;
}

export function tooLargeFile(name: string): string {
  return `“${name}” is larger than 512 MB, the most SPAWN D can move in one file.`;
}

export function tooLargeSkipped(names: readonly string[]): string {
  const [only] = names;
  return names.length === 1
    ? `${tooLargeFile(only ?? "")} It is left out.`
    : `${count(names.length)} files are larger than 512 MB, the most SPAWN D can move in one file. They are left out.`;
}

/** While a send's items are being counted on its source host. */
export function countingNotice(hostName: string, counted: number): string {
  return counted > 0
    ? `Counting items on ${hostName}… ${count(counted)} so far`
    : `Counting items on ${hostName}…`;
}

/** What a send carries, once counted: "12 items · 1.2 GB" (files), or the folders alone. */
export function sendSummary(files: number, folders: number, bytes: number): string {
  if (files === 0) return folders === 1 ? "1 empty folder" : `${count(folders)} empty folders`;
  return `${itemsLabel(files)} · ${formatFileSize(bytes)}`;
}

/**
 * "“notes.md” already exists in Documents on mac-mini." — or, for a picked
 * folder, "A folder named “photos” already exists in Documents on mac-mini."
 */
export function conflictQuestion({
  name,
  isDir,
  folderLabel,
  hostName,
}: {
  name: string;
  isDir: boolean;
  folderLabel: string;
  hostName: string;
}): string {
  return isDir
    ? `A folder named “${name}” already exists in ${folderLabel} on ${hostName}.`
    : `“${name}” already exists in ${folderLabel} on ${hostName}.`;
}

/** The answers to a taken name. Between two folders, Replace merges, and says so. */
export function conflictDecisionLabel(decision: ConflictDecision, bothFolders: boolean): string {
  if (decision === "replace") return bothFolders ? "Merge" : "Replace";
  return CONFLICT_POLICY_COPY[decision].label;
}

export function conflictApplyToRest(others: number): string {
  return `Do this for the other ${count(others)}`;
}

/**
 * One transfer, as the sheet names it: "Uploading “a.txt” to Documents on
 * dream", "Sending 3 items from dream to Documents on mac-mini", in the past
 * tense once it is done.
 */
export function transferTitle({
  verb,
  names,
  from,
  folderLabel,
  to,
  finished,
}: {
  verb: Exclude<TransferVerb, "download">;
  names: readonly string[];
  from?: string;
  folderLabel: string;
  to: string;
  finished: boolean;
}): string {
  const what = names.length === 1 ? `“${names[0]}”` : itemsLabel(names.length);
  const lead = finished ? VERB[verb].done : VERB[verb].doing;
  const where = `${folderLabel} on ${to}`;
  return verb === "upload"
    ? `${lead} ${what} to ${where}`
    : `${lead} ${what} from ${from} to ${where}`;
}

/** "12 MB of 1.2 GB · 3 of 12 items · about 3 minutes left" */
export function transferProgress({
  doneBytes,
  totalBytes,
  doneItems,
  totalItems,
  secondsLeft,
}: {
  doneBytes: number;
  totalBytes: number;
  doneItems: number;
  totalItems: number;
  secondsLeft: number | null;
}): string {
  const parts = [`${formatFileSize(doneBytes)} of ${formatFileSize(totalBytes)}`];
  if (totalItems > 1) parts.push(`${count(doneItems)} of ${itemsLabel(totalItems)}`);
  if (secondsLeft !== null) parts.push(`${formatDuration(secondsLeft)} left`);
  return parts.join(" · ");
}

/** A finished transfer: "12 items · 1.2 GB · 2 skipped". */
export function transferDoneSummary({
  items,
  bytes,
  skipped,
}: {
  items: number;
  bytes: number;
  skipped: number;
}): string {
  const parts = [itemsLabel(items), formatFileSize(bytes)];
  if (skipped > 0) parts.push(`${count(skipped)} skipped`);
  return parts.join(" · ");
}

/** "3 items couldn't be sent." */
export function transferFailedSummary(failed: number, verb: TransferVerb): string {
  return `${itemsLabel(failed)} couldn't be ${VERB[verb].past}.`;
}

/** A transfer waiting its turn: the phone moves one file at a time. */
export function queuedNotice(hostName: string): string {
  return `Waiting for another transfer with ${hostName} to finish`;
}

/** Why a transfer stopped part-way, with Resume beside it. */
export function interruptedNotice(interruption: TransferInterruption): string {
  return interruption.cause === "background"
    ? INTERRUPTED_ITEM
    : `Interrupted because SPAWN D lost touch with ${interruption.host}.`;
}

/** The banner over the file list while there are transfers to see: what needs the person first. */
export function transfersBannerLabel(summary: {
  active: number;
  percent: number | null;
  paused: boolean;
  needsYou: number;
}): string {
  if (summary.paused) return "Transfers paused";
  if (summary.needsYou > 0) {
    return summary.needsYou === 1
      ? "1 transfer needs you"
      : `${count(summary.needsYou)} transfers need you`;
  }
  if (summary.active === 0) return "Transfers done";
  const what = summary.active === 1 ? "1 transfer" : `${count(summary.active)} transfers`;
  return summary.percent === null ? what : `${what} · ${summary.percent}%`;
}

/** What finished: one notice per transfer, once every item has an outcome. */
export function uploadedNotice(names: readonly string[], folderLabel: string, hostName: string) {
  return names.length === 1
    ? `Uploaded “${names[0]}” to ${folderLabel} on ${hostName}`
    : `Uploaded ${itemsLabel(names.length)} to ${folderLabel} on ${hostName}`;
}

export function sentNotice(names: readonly string[], folderLabel: string, hostName: string) {
  return names.length === 1
    ? `Sent “${names[0]}” to ${folderLabel} on ${hostName}`
    : `Sent ${itemsLabel(names.length)} to ${folderLabel} on ${hostName}`;
}

export function savedAsLabel(name: string): string {
  return `Saved as “${name}”`;
}

export const ITEM_WAITING = "Waiting";
/** A big file is read once on the phone to fingerprint it before a byte is sent. */
export function preparingLabel(percent: number): string {
  return `Preparing… ${percent}%`;
}
export const ITEM_FINISHING = "Finishing…";
export const ITEM_DONE = "Done";
export const ITEM_REPLACED = "Replaced the one there";
export const ITEM_MERGED = "Merged into the one there";
export const ITEM_SKIPPED = "Skipped: one is already there";
export const ITEM_VERIFIED = "Arrived before the connection dropped";

/**
 * Why one file did not get where it was going, from the host's own code.
 * `side` says which host answered: a send reads from one and writes to the
 * other, and the sentence names the one that said no.
 */
export function transferErrorCopy(
  code: string | null,
  {
    name,
    hostName,
    folderLabel,
    side,
  }: { name: string; hostName: string; folderLabel: string; side: "source" | "destination" },
): string | null {
  switch (code) {
    case "already_exists":
      return conflictQuestion({ name, isDir: false, folderLabel, hostName });
    case "invalid_name":
    case "invalid_path":
      return `“${name}” can't be used as a name on ${hostName}.`;
    case "permission_denied":
      return side === "source"
        ? `SPAWN D on ${hostName} isn't allowed to read “${name}”.`
        : `SPAWN D on ${hostName} isn't allowed to write to ${folderLabel}.`;
    case "not_found":
      return side === "source"
        ? `“${name}” is no longer there on ${hostName}.`
        : `${folderLabel} is no longer there on ${hostName}.`;
    case "not_directory":
      return `${folderLabel} on ${hostName} isn't a folder.`;
    case "is_folder":
      return `There's a folder named “${name}” in ${folderLabel} on ${hostName}, so it wasn't replaced.`;
    case "symlink_rejected":
      return "That path goes through a link SPAWN D doesn't follow.";
    case "file_too_large":
      return tooLargeFile(name);
    case "local_missing":
      return `“${name}” couldn't be read on this device. Pick it again to upload it.`;
    case "file_changed":
    case "version_changed":
    case "local_file_changed":
      return `“${name}” changed while it was being copied. Try again.`;
    case "hash_mismatch":
    case "integrity_mismatch":
    case "length_mismatch":
      return `“${name}” didn't arrive intact on ${hostName}, so it wasn't kept. Try again.`;
    case "outcome_unknown":
      return `SPAWN D lost touch with ${hostName} before it answered, so “${name}” may or may not have arrived. Check the folder before trying again.`;
    case "io_error":
      return side === "source"
        ? `${hostName} couldn't read “${name}”.`
        : `${hostName} couldn't write “${name}”.`;
    case "unsupported_operation":
    case "streaming_unsupported":
    case "capabilities_unavailable":
      return side === "source"
        ? `SPAWN D on ${hostName} can't send files.`
        : `SPAWN D on ${hostName} can't receive files.`;
    case "connection_closed":
    case "stream_timeout":
      return `SPAWN D lost its connection to ${hostName}.`;
    case "host_unreachable":
      return `SPAWN D couldn't reach ${hostName}.`;
    default:
      return null;
  }
}

export function makeFolderFailed(folder: string, hostName: string): string {
  return `SPAWN D couldn't make the folder “${folder}” on ${hostName}.`;
}
