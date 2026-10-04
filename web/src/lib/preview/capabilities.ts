/**
 * What the file UI may offer, given what this host's daemon actually supports.
 *
 * Visibility is driven by the daemon's `hello.capabilities`, never by the
 * host's reported OS. A daemon that cannot reveal a file simply does not
 * advertise `desktop.reveal`, so an old daemon on a Mac correctly hides the
 * item and a future Linux daemon lights it up with no change here. `os` picks
 * the wording only — the name of the file manager differs, the capability does
 * not.
 *
 * Pure and DOM-free.
 */

export const FILE_OPS = {
  stat: "fs.stat",
  range: "fs.read.range",
  preview: "fs.preview",
  reveal: "desktop.reveal",
  open: "desktop.open",
} as const;

export type FileActionCapabilities = {
  /** Ask the host to select the file in its file manager. */
  reveal: boolean;
  /** Ask the host to hand the file to its default application. */
  open: boolean;
  /** Host can render a preview image for formats the browser cannot draw. */
  quicklook: boolean;
  /** Host supports bounded slice reads, so head previews are cheap. */
  range: boolean;
  /** Host supports single-entry metadata lookups. */
  stat: boolean;
  revealLabel: string;
  openLabel: string;
  /** Why previews are limited, when they are. Null when nothing is missing. */
  unavailableReason: string | null;
};

function revealLabelFor(os: string | null | undefined): string {
  switch (os) {
    case "macos":
      return "Reveal in Finder";
    case "windows":
      return "Reveal in File Explorer";
    default:
      return "Show in file manager";
  }
}

export function deriveFileCapabilities(
  capabilities: ReadonlySet<string>,
  os: string | null | undefined,
): FileActionCapabilities {
  const quicklook = capabilities.has(FILE_OPS.preview);
  return {
    reveal: capabilities.has(FILE_OPS.reveal),
    open: capabilities.has(FILE_OPS.open),
    quicklook,
    range: capabilities.has(FILE_OPS.range),
    stat: capabilities.has(FILE_OPS.stat),
    revealLabel: revealLabelFor(os),
    openLabel: "Open in default program",
    unavailableReason: quicklook
      ? null
      : "This host cannot render previews with its current daemon.",
  };
}

/** How many advertised names are read. A hello is one 16 KiB frame, and new
 *  op families are advertised as one versioned name each (`conv.v1`), so a
 *  real daemon stays far below this. */
export const MAX_CAPABILITIES = 256;
const MAX_CAPABILITY_LENGTH = 64;
const CAPABILITY_NAME = /^[a-z][a-z0-9._]*$/;

/**
 * Capabilities as announced by a daemon, validated name by name.
 *
 * A hello from a newer daemon carrying something unexpected must never cost
 * the names this client does know: an unreadable entry is skipped, and so is
 * anything past MAX_CAPABILITIES. Emptying the whole set instead would make a
 * longer list look like a daemon with no session transport at all, and the
 * connection would refuse a host that is fine. Only a hello whose list is not
 * a list at all offers nothing — the connection itself is still fine.
 */
export function parseCapabilities(value: unknown): ReadonlySet<string> {
  const parsed = new Set<string>();
  if (!Array.isArray(value)) return parsed;
  for (const entry of value.slice(0, MAX_CAPABILITIES)) {
    if (typeof entry !== "string" || entry.length > MAX_CAPABILITY_LENGTH) continue;
    if (!CAPABILITY_NAME.test(entry)) continue;
    parsed.add(entry);
  }
  return parsed;
}
