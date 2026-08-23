import { describe, expect, test } from "bun:test";
import {
  type IconCandidate,
  isIconDirName,
  isWorkspaceIcon,
  mergeIconCandidates,
  rankIconCandidates,
  scoreIconCandidate,
  WORKSPACE_ICON_MAX_CHARS,
  WORKSPACE_ICON_MAX_SOURCE_BYTES,
} from "./workspace-icon";

function file(name: string, size: number | null = 4096) {
  return { name, path: `/repo/${name}`, is_dir: false, size };
}

function best(dir: string, names: string[]): string | undefined {
  return rankIconCandidates(
    dir,
    names.map((name) => file(name)),
  )[0]?.name;
}

describe("scoring a folder's icon candidates", () => {
  test("a favicon beats every other name", () => {
    expect(best("", ["logo.png", "favicon.png", "screenshot.png", "icon.png"])).toBe("favicon.png");
  });

  test("an app icon or logo wins when there is no favicon", () => {
    expect(best("", ["duck.png", "logo.svg", "README.png"])).toBe("logo.svg");
  });

  test("non-images are not candidates at all", () => {
    expect(rankIconCandidates("", [file("README.md"), file("main.rs"), file("Makefile")])).toEqual(
      [],
    );
  });

  test("directories are never candidates, whatever they are called", () => {
    expect(
      rankIconCandidates("", [{ name: "icon.png", path: "/repo/icon.png", is_dir: true }]),
    ).toEqual([]);
  });

  test("a screenshot is refused outright rather than ranked low", () => {
    expect(scoreIconCandidate("", "screenshot.png")).toBeNull();
    expect(scoreIconCandidate("assets", "hero-banner.png")).toBeNull();
    expect(scoreIconCandidate("docs", "architecture-diagram.svg")).toBeNull();
  });

  test("a disqualifying word outranks an icon-ish one in the same name", () => {
    expect(scoreIconCandidate("", "logo-screenshot.png")).toBeNull();
  });

  test("an unnamed image is still a candidate, so a folder is rarely left bare", () => {
    expect(best("assets", ["duck.png"])).toBe("duck.png");
  });

  test("but an unnamed image never outranks a named one, wherever each sits", () => {
    const root = rankIconCandidates("", [file("duck.png", 900_000)]);
    const nested = rankIconCandidates("docs", [file("logo.png", 1_000)]);
    expect(mergeIconCandidates([root, nested])[0]?.name).toBe("logo.png");
  });

  test("an image too big to be an icon is refused before it is read", () => {
    expect(scoreIconCandidate("", "logo.png", WORKSPACE_ICON_MAX_SOURCE_BYTES + 1)).toBeNull();
    expect(scoreIconCandidate("", "logo.png", 100_000)).not.toBeNull();
  });

  test("between equal names, the one with pixels to spare wins", () => {
    const ranked = rankIconCandidates("", [
      { name: "logo.png", path: "/repo/a/logo.png", is_dir: false, size: 800 },
      { name: "logo.png", path: "/repo/b/logo.png", is_dir: false, size: 40_000 },
    ]);
    expect(ranked[0]?.path).toBe("/repo/b/logo.png");
  });

  test("dotfiles are skipped — a hidden file is not a project's mark", () => {
    expect(scoreIconCandidate("", ".icon.png")).toBeNull();
  });

  test("a name that merely mentions being a mark still outranks one that does not", () => {
    expect(best("", ["photo.png", "spawnd-icon-black.svg", "duck.png"])).toBe(
      "spawnd-icon-black.svg",
    );
  });

  test("a nested assets directory is scored as the assets directory it is", () => {
    const nested = rankIconCandidates("src/assets", [file("logo.png")]);
    const docs = rankIconCandidates("docs", [file("logo.png")]);
    expect(mergeIconCandidates([nested, docs])[0]?.dir).toBe("src/assets");
  });

  test("the folder itself outranks a subdirectory for the same name", () => {
    const root = rankIconCandidates("", [file("logo.png")]);
    const docs = rankIconCandidates("docs", [file("logo.png")]);
    expect(mergeIconCandidates([root, docs])[0]?.dir).toBe("");
  });
});

describe("which directories are worth stepping into", () => {
  test("the places a project keeps its assets", () => {
    for (const name of ["public", "assets", ".github", "icons", "web", "src", "packages"]) {
      expect(isIconDirName(name)).toBe(true);
    }
  });

  test("a project directory named after the project, whatever the project is called", () => {
    expect(isIconDirName("painpal-app")).toBe(true);
    expect(isIconDirName("singing_coach_web")).toBe(true);
    expect(isIconDirName("acme-client")).toBe(true);
  });

  test("and nothing else — the walk is a guess, not a crawl", () => {
    for (const name of ["node_modules", "target", "build", ".git", "vendor", "appendix"]) {
      expect(isIconDirName(name)).toBe(false);
    }
  });
});

describe("merging the directories a scan listed", () => {
  test("the same file reached twice appears once, at its best score", () => {
    const shared: IconCandidate = {
      path: "/repo/public/favicon.png",
      name: "favicon.png",
      dir: "public",
      size: 4096,
      score: 1,
    };
    const merged = mergeIconCandidates([[shared], [{ ...shared, dir: "", score: 99 }]]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.score).toBe(99);
  });

  test("nothing anywhere is an empty list, not a bad guess", () => {
    expect(mergeIconCandidates([[], []])).toEqual([]);
  });
});

describe("what may be stored as an icon", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";

  test("accepts the base64 raster data URLs the renderer produces", () => {
    expect(isWorkspaceIcon(png)).toBe(true);
    expect(isWorkspaceIcon("data:image/webp;base64,UklGRg==")).toBe(true);
  });

  test("refuses anything that would make a client fetch, or that carries markup", () => {
    expect(isWorkspaceIcon("https://example.com/logo.png")).toBe(false);
    expect(isWorkspaceIcon("data:image/svg+xml;base64,PHN2Zy8+")).toBe(false);
    expect(isWorkspaceIcon("data:text/html;base64,PGI+")).toBe(false);
    expect(isWorkspaceIcon(null)).toBe(false);
  });

  test("refuses an icon the server would reject for size", () => {
    expect(isWorkspaceIcon(`data:image/png;base64,${"A".repeat(WORKSPACE_ICON_MAX_CHARS)}`)).toBe(
      false,
    );
  });
});
