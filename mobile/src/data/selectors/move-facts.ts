import { type AgentYolo, agentYoloAvailable } from "@/data/selectors/agent-relaunch";
import type { ConnectionInfo } from "@/terminal/transport/types";

/**
 * The small facts a move's dialog shows, worked out on the device from what
 * the two hosts answered: which commit each folder is on (read from
 * `.git/HEAD` and its refs over the device's channels, never by running
 * git), how long the carry will take, whether the target's Claude Code is
 * older, and which permission mode the moved conversation starts in. The
 * browser works them out the same way (web/src/lib/move/estimate.ts,
 * git-head.ts and permission-modes.ts).
 */

/** Past this, the dialog says how long the carry will take. */
export const ESTIMATE_SHOWN_ABOVE_SECONDS = 15;
/** Bulk is paced at 64 KiB per association, counted until acknowledged. */
const WINDOW_BYTES = 64 * 1024;
/** The share of the window S4 saw used: 0.91 MB/s of 64 KiB per 55 ms. */
const EFFICIENCY = 0.76;
const DIRECT_CAP_BYTES_PER_SECOND = 20 * 1_000_000;
const RELAY_CAP_BYTES_PER_SECOND = 2 * 1_000_000;
/** What a phone moves through its bridge at best, whatever the path: the
 *  one difference from the browser's model. */
const DEVICE_CEILING_BYTES_PER_SECOND = 4_000_000;
/** Stopping the source, the commit, and starting the target. */
const FIXED_SECONDS = 3;

function legRate(leg: ConnectionInfo | null | undefined): number {
  const relayed = leg?.kind === "relay";
  const unmeasured = relayed || !leg?.kind ? 55 : 10;
  const rtt = Math.max(1, leg?.rttMs ?? unmeasured) / 1000;
  const cap = relayed ? RELAY_CAP_BYTES_PER_SECOND : DIRECT_CAP_BYTES_PER_SECOND;
  return Math.min(cap, (EFFICIENCY * WINDOW_BYTES) / rtt);
}

/**
 * Seconds a carry of `bytes` should take over the two connections it runs
 * on: each leg moves about one 64 KiB window per round trip (0.9 MB/s
 * relayed at 55 ms, as S4 measured), the device pumps both at once so the
 * slower leg sets the pace, and a few seconds go to stopping, committing and
 * starting.
 */
export function estimateCarrySeconds(
  bytes: number,
  legs: readonly (ConnectionInfo | null | undefined)[],
): number {
  const rate = Math.min(DEVICE_CEILING_BYTES_PER_SECOND, ...legs.map(legRate));
  return FIXED_SECONDS + bytes / rate;
}

/** "30 seconds", "a minute", "4 minutes", "an hour", "2 hours". */
export function formatCarryDuration(seconds: number): string {
  if (seconds < 55) return `${Math.max(5, Math.round(seconds / 5) * 5)} seconds`;
  if (seconds < 90) return "a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 55) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours <= 1 ? "an hour" : `${hours} hours`;
}

const UNITS = ["KB", "MB", "GB", "TB"] as const;

/**
 * "3.1 of 12.4 MB": how far a carry is, both figures in the total's unit
 * (1024-based, as every size SPAWN D shows), kilobytes whole and larger
 * units to a tenth; the unit is said once, after the total. The browser
 * writes the same (web/src/lib/move/copy.ts `formatProgress`).
 */
export function formatCarryProgress(sent: number, total: number): { done: string; total: string } {
  if (total < 1024) {
    return { done: `${Math.round(Math.min(sent, total))}`, total: `${Math.round(total)} B` };
  }
  let size = 1024;
  let unit = 0;
  while (total >= size * 1024 && unit < UNITS.length - 1) {
    size *= 1024;
    unit += 1;
  }
  const amount = (bytes: number) =>
    unit === 0 ? String(Math.round(bytes / size)) : (bytes / size).toFixed(1);
  return { done: amount(Math.min(sent, total)), total: `${amount(total)} ${UNITS[unit]}` };
}

/** Whether `version` is an older release than `than` (dotted numbers). */
export function olderVersion(version: string | null, than: string | null): boolean {
  if (!version || !than) return false;
  const parse = (value: string) =>
    value
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10));
  const a = parse(version);
  const b = parse(than);
  if ([...a, ...b].some((part) => !Number.isFinite(part))) return false;
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

// ---- git, read not run ------------------------------------------------------

export type GitHead =
  | { readonly kind: "branch"; readonly branch: string }
  | { readonly kind: "detached"; readonly commit: string };

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BRANCH_REF = /^ref: refs\/heads\/(\S{1,200})$/;

/** `.git/HEAD`: a branch, a detached commit, or nothing a reader can trust. */
export function parseGitHead(text: string): GitHead | null {
  const line = text.split("\n")[0]?.trim() ?? "";
  const branch = BRANCH_REF.exec(line);
  if (branch?.[1]) return { kind: "branch", branch: branch[1] };
  if (SHA.test(line)) return { kind: "detached", commit: line };
  return null;
}

/** A linked worktree's or submodule's `.git` file: where its git dir is. */
export function parseGitDirPointer(text: string): string | null {
  const match = /^gitdir: (.{1,1024})$/.exec(text.split("\n")[0]?.trim() ?? "");
  return match?.[1] ?? null;
}

/** A loose ref file's commit. */
export function parseLooseRef(text: string): string | null {
  const line = text.split("\n")[0]?.trim() ?? "";
  return SHA.test(line) ? line : null;
}

/** A ref's commit from `packed-refs`. */
export function findPackedRef(text: string, ref: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const [commit, name] = line.split(" ");
    if (name === ref && commit && SHA.test(commit)) return commit;
  }
  return null;
}

/** A path's parent and a relative path joined, `/`-separated. */
export function joinHostPath(base: string, relative: string): string {
  if (relative.startsWith("/") || relative.startsWith("~")) return relative;
  const parts = base.replace(/\/+$/, "").split("/");
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/") || "/";
}

export interface FolderCommit {
  readonly branch: string | null;
  readonly commit: string | null;
}

export const shortCommit = (commit: string) => commit.slice(0, 7);

/**
 * What the dialog says about the two folders' heads: the same branch (or
 * none) at the same commit, or anything else. Null when either is not a
 * repository it could read. Commits come back short.
 */
export type FolderComparison =
  | { readonly kind: "same"; readonly branch: string | null; readonly commit: string }
  | {
      readonly kind: "different";
      readonly from: { readonly branch: string | null; readonly commit: string | null };
      readonly to: { readonly branch: string | null; readonly commit: string | null };
    };

export function compareFolders(
  from: FolderCommit | null,
  to: FolderCommit | null,
): FolderComparison | null {
  if (!from || !to) return null;
  if (from.branch === to.branch && from.commit !== null && from.commit === to.commit) {
    return { kind: "same", branch: from.branch, commit: shortCommit(from.commit) };
  }
  const short = (state: FolderCommit) => ({
    branch: state.branch,
    commit: state.commit ? shortCommit(state.commit) : null,
  });
  return { kind: "different", from: short(from), to: short(to) };
}

// ---- the mode a moved conversation starts in --------------------------------

/** Claude Code's modes, in the order the picker lists them. */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * How the picker names each mode: Claude Code's own indicator, the words its
 * footer shows ("manual mode", "plan mode", …), with one line on what it
 * does. The browser lists the same (web/src/lib/move/permission-modes.ts).
 */
export const PERMISSION_MODE_CHOICES: Readonly<
  Record<PermissionMode, { readonly label: string; readonly description: string }>
> = {
  default: { label: "manual mode", description: "Asks before edits and commands" },
  acceptEdits: { label: "accept edits", description: "Edits files without asking" },
  plan: { label: "plan mode", description: "Plans without changing anything" },
  auto: { label: "auto mode", description: "Decides for itself what to ask about" },
  dontAsk: { label: "don't ask", description: "Refuses whatever isn't already allowed" },
  bypassPermissions: {
    label: "bypass permissions",
    description: "Never asks — what a yolo window runs in",
  },
};

export function permissionModeLabel(mode: PermissionMode): string {
  return PERMISSION_MODE_CHOICES[mode].label;
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * The mode the picker starts on, the same on every device: a yolo window
 * whose agent can skip its prompts keeps skipping them
 * (`bypassPermissions`, which the relaunch module writes in place of the
 * yolo flag); otherwise the target's own default (`permissions.defaultMode`
 * in its user-level Claude Code settings, read over the device's channel,
 * "manual" read as `default`), else Claude Code's `default`. Never the mode
 * the carried record ran in.
 */
export function defaultPermissionMode(
  agent: AgentYolo,
  targetSettings: string | null | undefined,
): PermissionMode {
  if (agent.yolo === true && agentYoloAvailable(agent)) return "bypassPermissions";
  if (targetSettings) {
    try {
      const parsed = JSON.parse(targetSettings) as { permissions?: { defaultMode?: unknown } };
      const mode = parsed?.permissions?.defaultMode;
      if (mode === "manual") return "default";
      if (isPermissionMode(mode)) return mode;
    } catch {
      // A settings file that is not JSON names no default.
    }
  }
  return "default";
}
