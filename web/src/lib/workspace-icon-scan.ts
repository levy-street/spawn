/**
 * Walking a workspace's folder on the host, looking for its mark.
 *
 * The whole scan runs over the same `spawn.host.ctl` channel the folder picker
 * uses — `fs.list` to see what is there, `fs.read` to pull the winner — so no
 * new capability is asked of the daemon and nothing goes near the server until
 * the browser has turned the file into a small square raster.
 *
 * The walk is deliberately shallow and bounded (`WORKSPACE_ICON_MAX_DEPTH`,
 * `WORKSPACE_ICON_MAX_DIRS`): opening a workspace should cost a handful of
 * round trips, not a directory crawl. Which files are worth having is decided
 * in `workspace-icon.ts`; turning one into an icon is `workspace-icon-image`.
 */

import type { HostDirEntry, HostDirList, HostReadStream } from "@/lib/hostControl";
import { trimTrailingSlash } from "@/lib/paths";
import {
  type IconCandidate,
  isIconDirName,
  mergeIconCandidates,
  rankIconCandidates,
  WORKSPACE_ICON_DIR_PAGES,
  WORKSPACE_ICON_MAX_DEPTH,
  WORKSPACE_ICON_MAX_DIRS,
  WORKSPACE_ICON_MAX_SOURCE_BYTES,
} from "@/lib/workspace-icon";
import { iconMimeForName, renderWorkspaceIcon } from "@/lib/workspace-icon-image";

/** What the scan needs of a host connection — the two reads the folder picker
 *  already performs. Narrow on purpose, so the walk can be exercised against a
 *  stub directory tree. */
export type IconScanClient = {
  listPage(path: string, cursor: number): Promise<HostDirList>;
  readFile(path: string): Promise<HostReadStream>;
};

/** How many of the ranked candidates a single automatic scan will actually
 *  pull and try to render before settling for no icon. */
const AUTO_RENDER_ATTEMPTS = 3;

function childPath(parent: string, name: string): string {
  return `${trimTrailingSlash(parent)}/${name}`;
}

async function listDirectory(client: IconScanClient, path: string): Promise<HostDirEntry[]> {
  const entries: HostDirEntry[] = [];
  let cursor = 0;
  for (let page = 0; page < WORKSPACE_ICON_DIR_PAGES; page += 1) {
    const result = await client.listPage(path, cursor);
    entries.push(...result.entries);
    if (result.truncated === true || typeof result.next_cursor !== "number") break;
    cursor = result.next_cursor;
  }
  return entries;
}

/**
 * Every image in and under `cwd` that could be the folder's mark, best first.
 *
 * A directory that cannot be listed — gone, unreadable, not a directory at all
 * — is skipped rather than failing the scan: a missing `public/` says nothing
 * about the `favicon.png` sitting next to it.
 */
export async function scanFolderForIcons(
  client: IconScanClient,
  cwd: string,
): Promise<IconCandidate[]> {
  const root = trimTrailingSlash(cwd);
  const groups: IconCandidate[][] = [];
  // Breadth-first, so the shallow directories — the ones a mark is most
  // likely to be in — are the ones that get listed if the budget runs out.
  let frontier: Array<{ path: string; relative: string }> = [{ path: root, relative: "" }];
  let listed = 0;

  for (let depth = 0; depth <= WORKSPACE_ICON_MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: Array<{ path: string; relative: string }> = [];
    for (const directory of frontier) {
      if (listed >= WORKSPACE_ICON_MAX_DIRS) break;
      listed += 1;
      let entries: HostDirEntry[];
      try {
        entries = await listDirectory(client, directory.path);
      } catch {
        continue;
      }
      groups.push(rankIconCandidates(directory.relative, entries));
      if (depth === WORKSPACE_ICON_MAX_DEPTH) continue;
      for (const entry of entries) {
        if (!entry.is_dir || !isIconDirName(entry.name)) continue;
        next.push({
          path: entry.path || childPath(directory.path, entry.name),
          relative: directory.relative ? `${directory.relative}/${entry.name}` : entry.name,
        });
      }
    }
    frontier = next;
  }
  return mergeIconCandidates(groups);
}

/**
 * One candidate, read off the host and rendered — or null if it turns out not
 * to be a usable image after all (a `.png` that is really a text file, an
 * `.ico` this browser will not decode, a file that grew since it was listed).
 */
export async function renderCandidate(
  client: IconScanClient,
  candidate: IconCandidate,
  render: (blob: Blob) => Promise<string | null> = renderWorkspaceIcon,
): Promise<string | null> {
  const mime = iconMimeForName(candidate.name);
  if (!mime) return null;
  let read: HostReadStream;
  try {
    read = await client.readFile(candidate.path);
  } catch {
    return null;
  }
  // The declared length is the first trustworthy size: a listing's `size` can
  // be stale or absent, and this is the number the transfer will actually
  // move.
  if (read.length > WORKSPACE_ICON_MAX_SOURCE_BYTES) {
    await read.stream.cancel("too large to be an icon").catch(() => {});
    return null;
  }
  try {
    const blob = await new Response(read.stream).blob();
    // The host serves bytes, not content types; the extension is what tells
    // the browser how to decode them.
    return await render(blob.slice(0, blob.size, mime));
  } catch {
    return null;
  }
}

/**
 * The folder's icon, or null when it has nothing worth wearing.
 *
 * Tries the best few candidates rather than only the best one, so a favicon
 * that fails to decode does not cost the workspace the perfectly good logo
 * ranked behind it.
 */
export async function findFolderIcon(
  client: IconScanClient,
  cwd: string,
  render?: (blob: Blob) => Promise<string | null>,
): Promise<string | null> {
  const candidates = await scanFolderForIcons(client, cwd);
  for (const candidate of candidates.slice(0, AUTO_RENDER_ATTEMPTS)) {
    const icon = await renderCandidate(client, candidate, render);
    if (icon) return icon;
  }
  return null;
}

export type IconSuggestion = { icon: string; candidate: IconCandidate };

/**
 * What the picker offers: the best candidates, already rendered, so choosing
 * one is a click rather than another round trip. Rendered in rank order and
 * stopped at `max` usable results — a folder full of undecodable `.ico`s
 * should not become a folder full of empty tiles.
 */
export async function suggestFolderIcons(
  client: IconScanClient,
  cwd: string,
  {
    max = 6,
    attempts = 12,
    render,
  }: { max?: number; attempts?: number; render?: (blob: Blob) => Promise<string | null> } = {},
): Promise<IconSuggestion[]> {
  const candidates = await scanFolderForIcons(client, cwd);
  const suggestions: IconSuggestion[] = [];
  for (const candidate of candidates.slice(0, attempts)) {
    if (suggestions.length >= max) break;
    const icon = await renderCandidate(client, candidate, render);
    if (icon) suggestions.push({ icon, candidate });
  }
  return suggestions;
}
