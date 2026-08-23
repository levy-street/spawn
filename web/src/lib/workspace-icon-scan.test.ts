import { describe, expect, test } from "bun:test";
import type { HostDirEntry, HostDirList, HostReadStream } from "@/lib/hostControl";
import { WORKSPACE_ICON_MAX_SOURCE_BYTES } from "@/lib/workspace-icon";
import {
  findFolderIcon,
  type IconScanClient,
  renderCandidate,
  scanFolderForIcons,
  suggestFolderIcons,
} from "@/lib/workspace-icon-scan";

const ROOT = "/Users/alice/project";
const ICON = "data:image/webp;base64,UklGRg==";

type Node = [name: string, isDir: boolean, size?: number];

/** A stub host: a directory tree in memory, plus a record of what was asked
 *  for, so the walk's *shape* is observable and not only its answer. */
function stubHost(
  tree: Record<string, Node[]>,
  { fileSize = 4096 }: { fileSize?: number } = {},
): IconScanClient & { listed: string[]; read: string[] } {
  const listed: string[] = [];
  const read: string[] = [];
  return {
    listed,
    read,
    listPage: async (path: string): Promise<HostDirList> => {
      listed.push(path);
      const entries = tree[path];
      if (!entries) throw new Error("not_found");
      return {
        path,
        home_dir: "/Users/alice",
        entries: entries.map(
          ([name, isDir, size]): HostDirEntry => ({
            name,
            path: `${path}/${name}`,
            kind: isDir ? "directory" : "file",
            is_dir: isDir,
            size: size ?? (isDir ? null : fileSize),
          }),
        ),
        next_cursor: null,
      };
    },
    readFile: async (path: string): Promise<HostReadStream> => {
      read.push(path);
      const bytes = new Uint8Array(fileSize);
      return {
        streamId: path,
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        length: fileSize,
        sha256: "0".repeat(64),
        stream: new Blob([bytes]).stream(),
      };
    },
  };
}

const rendersAnything = async () => ICON;

describe("walking a folder for its mark", () => {
  test("finds the favicon a project keeps in public/", async () => {
    const host = stubHost({
      [ROOT]: [
        ["public", true],
        ["README.md", false],
        ["package.json", false],
      ],
      [`${ROOT}/public`]: [
        ["favicon.png", false],
        ["robots.txt", false],
      ],
    });
    const candidates = await scanFolderForIcons(host, ROOT);
    expect(candidates.map((c) => c.path)).toEqual([`${ROOT}/public/favicon.png`]);
  });

  test("descends only into the directories a mark lives in", async () => {
    const host = stubHost({
      [ROOT]: [
        ["node_modules", true],
        ["target", true],
        ["assets", true],
        ["logo.png", false],
      ],
      [`${ROOT}/assets`]: [],
      [`${ROOT}/node_modules`]: [["icon.png", false]],
      [`${ROOT}/target`]: [["icon.png", false]],
    });
    await scanFolderForIcons(host, ROOT);
    expect(host.listed).toEqual([ROOT, `${ROOT}/assets`]);
  });

  test("reaches a monorepo's favicon three directories down, and stops there", async () => {
    const host = stubHost({
      [ROOT]: [["web", true]],
      [`${ROOT}/web`]: [["public", true]],
      [`${ROOT}/web/public`]: [["brand", true]],
      [`${ROOT}/web/public/brand`]: [
        ["logo.svg", false],
        ["icons", true],
      ],
      [`${ROOT}/web/public/brand/icons`]: [["favicon.png", false]],
    });
    const candidates = await scanFolderForIcons(host, ROOT);
    expect(candidates.map((c) => c.path)).toEqual([`${ROOT}/web/public/brand/logo.svg`]);
    // The fourth level is past the budget of guessing.
    expect(host.listed).not.toContain(`${ROOT}/web/public/brand/icons`);
  });

  test("steps into a project directory named after the project", async () => {
    const host = stubHost({
      [ROOT]: [
        ["painpal-app", true],
        ["painpal-notes", true],
      ],
      [`${ROOT}/painpal-app`]: [["assets", true]],
      [`${ROOT}/painpal-app/assets`]: [["favicon.png", false]],
      [`${ROOT}/painpal-notes`]: [["logo.png", false]],
    });
    const candidates = await scanFolderForIcons(host, ROOT);
    expect(candidates.map((c) => c.path)).toEqual([`${ROOT}/painpal-app/assets/favicon.png`]);
    // A sibling that is not an app is not a place to look for one's mark.
    expect(host.listed).not.toContain(`${ROOT}/painpal-notes`);
  });

  test("a directory that cannot be listed costs nothing but itself", async () => {
    const host = stubHost({
      [ROOT]: [
        ["public", true],
        ["logo.png", false],
      ],
      // `public` is absent from the tree, so listing it throws.
    });
    const candidates = await scanFolderForIcons(host, ROOT);
    expect(candidates.map((c) => c.name)).toEqual(["logo.png"]);
  });

  test("a folder with nothing to wear yields nothing rather than a bad guess", async () => {
    const host = stubHost({
      [ROOT]: [
        ["main.rs", false],
        ["screenshot.png", false],
      ],
    });
    expect(await scanFolderForIcons(host, ROOT)).toEqual([]);
  });

  test("a trailing slash on the folder does not double up in the paths", async () => {
    const host = stubHost({ [ROOT]: [["logo.png", false]] });
    const candidates = await scanFolderForIcons(host, `${ROOT}/`);
    expect(candidates[0]?.path).toBe(`${ROOT}/logo.png`);
  });
});

describe("turning a candidate into an icon", () => {
  test("reads the winner and renders it", async () => {
    const host = stubHost({
      [ROOT]: [
        ["favicon.png", false],
        ["logo.png", false],
      ],
    });
    expect(await findFolderIcon(host, ROOT, rendersAnything)).toBe(ICON);
    expect(host.read).toEqual([`${ROOT}/favicon.png`]);
  });

  test("a candidate that will not decode does not cost the folder the next one", async () => {
    const host = stubHost({
      [ROOT]: [
        ["favicon.ico", false],
        ["logo.png", false],
      ],
    });
    // The first read fails to decode, the second does not.
    const render = async () => (host.read.length < 2 ? null : ICON);
    expect(await findFolderIcon(host, ROOT, render)).toBe(ICON);
    expect(host.read).toEqual([`${ROOT}/favicon.ico`, `${ROOT}/logo.png`]);
  });

  test("gives up rather than returning something unrenderable", async () => {
    const host = stubHost({ [ROOT]: [["logo.png", false]] });
    expect(await findFolderIcon(host, ROOT, async () => null)).toBeNull();
  });

  test("a file that outgrew its listing is dropped at the declared length", async () => {
    const host = stubHost(
      { [ROOT]: [["logo.png", false, 1024]] },
      { fileSize: WORKSPACE_ICON_MAX_SOURCE_BYTES + 1 },
    );
    const candidates = await scanFolderForIcons(host, ROOT);
    expect(candidates).toHaveLength(1);
    expect(
      await renderCandidate(host, candidates[0] as (typeof candidates)[number], rendersAnything),
    ).toBeNull();
  });

  test("the picker's suggestions come back ranked and capped", async () => {
    const host = stubHost({
      [ROOT]: [
        ["favicon.png", false],
        ["logo.png", false],
        ["duck.png", false],
      ],
    });
    const suggestions = await suggestFolderIcons(host, ROOT, { max: 2, render: rendersAnything });
    expect(suggestions.map((s) => s.candidate.name)).toEqual(["favicon.png", "logo.png"]);
  });
});
