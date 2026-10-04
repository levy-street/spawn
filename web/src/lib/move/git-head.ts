/**
 * Which branch and commit a folder is on, read from `.git` with `fs.read` —
 * no git runs on either host (OD11: only `.git/HEAD` and refs until a
 * hardened git is reviewed). A linked worktree's `.git` file is followed to
 * its git directory and that directory's `commondir` for refs.
 *
 * Shown in the move dialog only; nothing read here goes into the note.
 */

export interface GitHead {
  /** The branch, or null when HEAD is detached. */
  branch: string | null;
  /** The commit's first seven hex digits, or null when it cannot be read. */
  commit: string | null;
}

/** Reads at most `limit` bytes of a file on the host as text; null when there is none. */
export type ReadText = (path: string, limit: number) => Promise<string | null>;

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HEAD_LIMIT = 4 * 1024;
const PACKED_REFS_LIMIT = 256 * 1024;

function join(base: string, relative: string): string {
  if (relative.startsWith("/") || relative.startsWith("~")) return relative;
  const parts = base.replace(/\/+$/, "").split("/");
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/") || "/";
}

/** `ref: refs/heads/x` or a commit id; anything else is not a HEAD. */
export function parseHead(text: string): { ref: string } | { commit: string } | null {
  const line = text.split("\n")[0]?.trim() ?? "";
  const ref = /^ref:\s*(refs\/\S+)$/.exec(line);
  if (ref?.[1]) return { ref: ref[1] };
  return SHA.test(line) ? { commit: line } : null;
}

function packedRef(packed: string, ref: string): string | null {
  for (const line of packed.split("\n")) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha && SHA.test(sha)) return sha;
  }
  return null;
}

/** The folder's HEAD, or null when it is not a git working tree SPAWN D can read. */
export async function readGitHead(read: ReadText, cwd: string): Promise<GitHead | null> {
  let gitDir = join(cwd, ".git");
  let head = await read(`${gitDir}/HEAD`, HEAD_LIMIT).catch(() => null);
  if (head === null) {
    // A linked worktree or submodule: `.git` is a file naming its git dir.
    const pointer = await read(gitDir, HEAD_LIMIT).catch(() => null);
    const target = pointer ? /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim() : undefined;
    if (!target) return null;
    gitDir = join(cwd, target);
    head = await read(`${gitDir}/HEAD`, HEAD_LIMIT).catch(() => null);
    if (head === null) return null;
  }
  const parsed = parseHead(head);
  if (!parsed) return null;
  if ("commit" in parsed) return { branch: null, commit: parsed.commit.slice(0, 7) };
  const branch = parsed.ref.replace(/^refs\/heads\//, "");
  const common = await read(`${gitDir}/commondir`, HEAD_LIMIT).catch(() => null);
  const refsDir = common?.trim() ? join(gitDir, common.trim()) : gitDir;
  const loose = (await read(`${refsDir}/${parsed.ref}`, HEAD_LIMIT).catch(() => null))?.trim();
  if (loose && SHA.test(loose)) return { branch, commit: loose.slice(0, 7) };
  const packed = await read(`${refsDir}/packed-refs`, PACKED_REFS_LIMIT).catch(() => null);
  const sha = packed ? packedRef(packed, parsed.ref) : null;
  return { branch, commit: sha ? sha.slice(0, 7) : null };
}

/** Whether two heads are the same branch at the same commit. */
export function sameHead(a: GitHead, b: GitHead): boolean {
  return a.branch === b.branch && a.commit !== null && a.commit === b.commit;
}
