/**
 * Why a folder would not open or a change did not happen, from the host's own
 * error code. The web file browser says the same thing in the same words
 * (web/src/lib/files/copy.ts, listErrorCopy and changeErrorCopy), and every
 * sentence about a host names it.
 */

/** "goto" is a folder typed into Go to folder, which may never have existed. */
export type FileErrorContext = "list" | "goto" | "write" | "rename" | "remove";

export interface FileErrorSubject {
  /** The host's name, as the rest of the app shows it. */
  host: string;
  /** The item a change was about: the name typed for a new one, the item's own otherwise. */
  name?: string;
}

const KNOWN_CODES = [
  "outside_root",
  "traversal_rejected",
  "permission_denied",
  "not_found",
  "not_directory",
  "symlink_rejected",
  "already_exists",
  "root_protected",
  "invalid_name",
  "invalid_path",
  "outcome_unknown",
] as const;

/** The host's code for a failure, whether it came as a field or only in the message. */
export function fileErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const direct = "code" in error ? error.code : undefined;
  if (typeof direct === "string") return direct;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return KNOWN_CODES.find((code) => message.includes(code)) ?? null;
}

/** Why a folder could not be opened. */
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

/** Why a change (new, rename, delete) did not happen. */
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
    case "outcome_unknown":
      return `SPAWN D lost touch with ${host} before it answered, so this may or may not have happened. Check the folder before trying again.`;
    default:
      return null;
  }
}

export function fileErrorMessage(
  error: unknown,
  context: FileErrorContext,
  { host, name }: FileErrorSubject,
): string {
  const code = fileErrorCode(error);
  const listing = context === "list" || context === "goto";
  const known = listing
    ? listErrorCopy(code, host)
    : changeErrorCopy(code, { host, name: name ?? "" });
  if (known && (listing || name !== undefined || code === "outcome_unknown")) return known;
  if (error instanceof Error && error.message.trim()) return error.message;
  return listing
    ? `SPAWN D couldn't list this folder on ${host}.`
    : `SPAWN D couldn't change this on ${host}.`;
}
