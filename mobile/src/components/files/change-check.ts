/**
 * Telling a refusal from a change that may have happened.
 *
 * SPAWN D's file service on a host cannot prove that a failed rename, new
 * folder or delete left nothing behind, so it answers every failure inside
 * one as `outcome_unknown` — a name already taken included. And its New
 * folder is `mkdir -p`: a folder already there is answered as made. Read as
 * they come, the first says "SPAWN D lost touch" to a host that answered at
 * once, and the second shows an old folder as if it were new.
 *
 * So the phone asks the folder it already holds first, and when the host
 * still cannot vouch for the outcome it looks at the names involved and says
 * what is now true. "Lost touch" is kept for when even that look cannot be
 * had. The web file browser does the same (web/src/lib/files/change-check.ts).
 */

/** What is at a path, as far as the host will say. */
export type Presence = "folder" | "item" | "absent" | "unknown";

/**
 * What a change the host could not vouch for turned out to be. Every value but
 * `done` is a code `changeErrorCopy` reads; `outcome_unknown` is the host's
 * own answer, kept.
 */
export type ChangeVerdict =
  | "done"
  | "already_exists"
  | "not_found"
  | "unchanged"
  | "outcome_unknown";

/** A listing the phone holds for a folder. */
export interface HeldFolder {
  entries: readonly { name: string; path: string }[];
  /**
   * Every name in the folder, as of the last read. Not when the host stopped
   * listing at its cap, or a big folder has changed since: a name may be there
   * unseen.
   */
  complete: boolean;
}

/** The host calls a check needs, and how the phone reads and raises their errors. */
export interface ChangeProbe {
  /** `fs.stat`, or null on a host that does not offer it. */
  stat: ((path: string) => Promise<{ kind: string }>) | null;
  codeOf(error: unknown): string | null;
}

/** An error carrying the code the change-error copy reads. */
export function changeRefusal(code: Exclude<ChangeVerdict, "done">): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** Whether another item in the folder is called `name`, exactly as typed. */
export function nameTaken(
  entries: HeldFolder["entries"] | undefined,
  name: string,
  /** The item being renamed, which may keep its own name. */
  except?: string,
): boolean {
  return (entries ?? []).some((entry) => entry.name === name && entry.path !== except);
}

/** Asks the host what is at `path` now. */
export async function presenceAt(probe: ChangeProbe, path: string): Promise<Presence> {
  if (!probe.stat) return "unknown";
  try {
    const found = await probe.stat(path);
    return found.kind === "directory" ? "folder" : "item";
  } catch (error) {
    const code = probe.codeOf(error);
    if (code === "not_found") return "absent";
    // A link is refused rather than followed, but it is there all the same.
    if (code === "symlink_rejected") return "item";
    return "unknown";
  }
}

const present = (presence: Presence) => presence === "folder" || presence === "item";

/** A rename the host could not vouch for, read from both names afterwards. */
export function renameVerdict(source: Presence, destination: Presence): ChangeVerdict {
  if (source === "unknown" || destination === "unknown") return "outcome_unknown";
  if (present(destination)) return present(source) ? "already_exists" : "done";
  return present(source) ? "unchanged" : "not_found";
}

/**
 * A new folder the host could not vouch for, read from its name afterwards.
 * Anything there but a folder was there before it: the host makes folders.
 */
export function newFolderVerdict(destination: Presence): ChangeVerdict {
  switch (destination) {
    case "folder":
      return "done";
    case "item":
      return "already_exists";
    case "absent":
      return "unchanged";
    default:
      return "outcome_unknown";
  }
}

/**
 * Two names a host that folds case or Unicode form may take for one. A rename
 * between them leaves both names answering afterwards whether or not it
 * happened, so looking cannot settle it.
 */
export function namesMayCoincide(a: string, b: string): boolean {
  return a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
}

/**
 * New folder that never adopts what is already there. The folder held on
 * screen answers first; when it may not show every name, the host is asked
 * about the name before anything is made, since `mkdir -p` would say yes to
 * an old folder. Resolves to the new folder's path.
 */
export async function createFolderChecked({
  path,
  name,
  held,
  mkdir,
  probe,
}: {
  path: string;
  name: string;
  held: HeldFolder | null;
  mkdir(): Promise<string>;
  probe: ChangeProbe;
}): Promise<string> {
  if (nameTaken(held?.entries, name)) throw changeRefusal("already_exists");
  if (!held?.complete && present(await presenceAt(probe, path))) {
    throw changeRefusal("already_exists");
  }
  try {
    return await mkdir();
  } catch (error) {
    if (probe.codeOf(error) !== "outcome_unknown") throw error;
    const verdict = newFolderVerdict(await presenceAt(probe, path));
    if (verdict === "done") return path;
    if (verdict === "outcome_unknown") throw error;
    throw changeRefusal(verdict);
  }
}

/**
 * Rename that says "already exists" when the name is taken, whether the
 * folder held on screen shows it or the host's answer has to be checked.
 * Resolves to the item's new path.
 */
export async function renameChecked({
  from,
  fromName,
  to,
  name,
  held,
  rename,
  probe,
}: {
  from: string;
  /** The item's name now. */
  fromName: string;
  to: string;
  name: string;
  held: HeldFolder | null;
  rename(): Promise<string>;
  probe: ChangeProbe;
}): Promise<string> {
  if (nameTaken(held?.entries, name, from)) throw changeRefusal("already_exists");
  try {
    return await rename();
  } catch (error) {
    if (probe.codeOf(error) !== "outcome_unknown" || namesMayCoincide(fromName, name)) throw error;
    const [source, destination] = await Promise.all([
      presenceAt(probe, from),
      presenceAt(probe, to),
    ]);
    const verdict = renameVerdict(source, destination);
    if (verdict === "done") return to;
    if (verdict === "outcome_unknown") throw error;
    throw changeRefusal(verdict);
  }
}
