import { describe, expect, test } from "bun:test";
import { classifyFile, extensionOf, isNativeKind, isTextKind, PREVIEW_BUDGET } from "./file-kinds";

function kindOf(name: string) {
  return classifyFile({ name, kind: "file" }).kind;
}

describe("extensionOf", () => {
  test("reads the final extension, lowercased", () => {
    expect(extensionOf("Photo.PNG")).toBe("png");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });

  test("a leading dot is a name, not an extension", () => {
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf(".env")).toBe("");
  });

  test("no extension, or a trailing dot, yields nothing", () => {
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf("weird.")).toBe("");
  });
});

describe("classifyFile — entry kinds", () => {
  test("a symlink is never previewable", () => {
    // The daemon walks components with no-follow semantics and rejects the
    // leaf as well, so there are no bytes to read however the name looks.
    const info = classifyFile({ name: "latest.png", kind: "symlink" });
    expect(info.kind).toBe("none");
    expect(info.icon).toBe("symlink");
    expect(info.label).toBe("Symbolic link");
  });

  test("fifos, sockets and devices are opaque", () => {
    expect(classifyFile({ name: "pipe", kind: "other" }).kind).toBe("none");
  });

  test("a directory is not a preview target", () => {
    expect(classifyFile({ name: "src", kind: "directory" }).kind).toBe("none");
  });
});

describe("classifyFile — resolution order", () => {
  test("whole-name files beat any extension reading", () => {
    expect(kindOf("Dockerfile")).toBe("code");
    expect(classifyFile({ name: "Makefile", kind: "file" }).icon).toBe("terminal");
    expect(classifyFile({ name: "CMakeLists.txt", kind: "file" }).language).toBe("shell");
  });

  test("whole-name matching is case-insensitive", () => {
    expect(kindOf("DOCKERFILE")).toBe("code");
    expect(kindOf("dockerfile")).toBe("code");
  });

  test("compound extensions beat the single-extension table", () => {
    // `.d.ts` must not read as plain TypeScript, and `.tar.gz` must not read
    // as a bare gzip stream.
    expect(classifyFile({ name: "index.d.ts", kind: "file" }).label).toBe(
      "TypeScript declarations",
    );
    expect(classifyFile({ name: "bundle.min.js", kind: "file" }).label).toBe("Minified JavaScript");
    expect(classifyFile({ name: "backup.tar.gz", kind: "file" }).label).toBe("Gzipped tar archive");
  });

  test("a name that is only the compound suffix is not a compound match", () => {
    // `.d.ts` as a whole filename has no stem, so it is an ordinary dotfile
    // that happens to end in `.ts` — TypeScript source, not a declaration file.
    const info = classifyFile({ name: ".d.ts", kind: "file" });
    expect(info.label).toBe("TypeScript");
    expect(info.label).not.toBe("TypeScript declarations");
  });

  test("extensionless files are read as text, not sent to the host renderer", () => {
    // A licence or readme is text; asking the host to render it costs a
    // subprocess and seconds, to arrive at the same place.
    for (const name of ["LICENSE-MIT", "README", "CHANGELOG-2024", "AUTHORS"]) {
      expect(kindOf(name)).toBe("text");
    }
    expect(classifyFile({ name: "LICENSE-MIT", kind: "file" }).label).toBe("License");
    expect(classifyFile({ name: "README", kind: "file" }).label).toBe("Readme");
    expect(classifyFile({ name: "some-random-file", kind: "file" }).label).toBe("Text file");
  });

  test("unknown extensions fall through to the host renderer", () => {
    // The daemon decides whether it can actually render it; guessing "none"
    // here would hide previews for every format QuickLook supports.
    const info = classifyFile({ name: "drawing.dwg", kind: "file" });
    expect(info.kind).toBe("quicklook");
    expect(info.icon).toBe("file");
  });
});

describe("classifyFile — preview kinds", () => {
  test("SVG is its own kind, never a plain image", () => {
    // It renders through <img> only. Inlining untrusted markup into the DOM
    // would execute any script it carries.
    expect(kindOf("logo.svg")).toBe("svg");
    expect(classifyFile({ name: "logo.svg", kind: "file" }).mime).toBe("image/svg+xml");
  });

  test("HTML is shown as source, not rendered", () => {
    expect(kindOf("index.html")).toBe("code");
    expect(kindOf("page.xhtml")).toBe("code");
  });

  test("browser-native media keep their real MIME", () => {
    expect(classifyFile({ name: "clip.mp4", kind: "file" }).mime).toBe("video/mp4");
    expect(classifyFile({ name: "song.flac", kind: "file" }).mime).toBe("audio/flac");
    expect(classifyFile({ name: "shot.webp", kind: "file" }).mime).toBe("image/webp");
  });

  test("formats no browser decodes go to the host renderer", () => {
    for (const name of ["deck.key", "notes.pages", "book.numbers", "art.psd", "ui.sketch"]) {
      expect(kindOf(name)).toBe("quicklook");
    }
    // HEIC only decodes in Safari, so it is not treated as native.
    expect(kindOf("IMG_0001.heic")).toBe("quicklook");
  });

  test("office documents map to distinct icons", () => {
    expect(classifyFile({ name: "a.docx", kind: "file" }).icon).toBe("doc");
    expect(classifyFile({ name: "a.xlsx", kind: "file" }).icon).toBe("sheet");
    expect(classifyFile({ name: "a.pptx", kind: "file" }).icon).toBe("slides");
  });

  test("markdown is its own kind so the source view can be swapped for a render", () => {
    expect(kindOf("README.md")).toBe("markdown");
    expect(kindOf("post.mdx")).toBe("markdown");
  });
});

describe("classifyFile — executables", () => {
  test("scripts are readable as source but flagged unopenable", () => {
    const sh = classifyFile({ name: "deploy.sh", kind: "file" });
    expect(sh.kind).toBe("code");
    expect(sh.executable).toBe(true);
  });

  test("bundles, installers and binaries are flagged", () => {
    for (const name of ["Foo.app", "run.command", "setup.pkg", "tool.exe", "lib.dylib"]) {
      expect(classifyFile({ name, kind: "file" }).executable).toBe(true);
    }
  });

  test("URL-indirection files are flagged despite looking like text", () => {
    // These are the classic allowlist bypass: a tiny plist that hands an
    // arbitrary scheme to the OS.
    for (const name of ["link.webloc", "site.inetloc", "doc.fileloc", "go.url", "s.lnk"]) {
      expect(classifyFile({ name, kind: "file" }).executable).toBe(true);
    }
  });

  test("ordinary documents are not flagged", () => {
    for (const name of ["notes.txt", "photo.png", "report.pdf", "app.ts"]) {
      expect(classifyFile({ name, kind: "file" }).executable).toBeUndefined();
    }
  });
});

describe("classifyFile — budgets", () => {
  test("every classification carries both budgets", () => {
    for (const name of ["a.png", "b.mp4", "c.docx", "d.ts", "e.unknown", "f.zip"]) {
      const info = classifyFile({ name, kind: "file" });
      expect(info.autoBytes).toBeGreaterThan(0);
      expect(info.maxBytes).toBeGreaterThanOrEqual(info.autoBytes);
    }
  });

  test("media may exceed the inline ceiling because the host can open it", () => {
    expect(classifyFile({ name: "movie.mov", kind: "file" }).maxBytes).toBeGreaterThan(
      PREVIEW_BUDGET.inlineMax,
    );
  });

  test("host render sizes are ones the daemon will actually accept", () => {
    // The daemon refuses anything outside its allowlist rather than clamping,
    // so a size that is merely reasonable still fails every request.
    const allowlisted = [128, 256, 512, 1024];
    expect(allowlisted).toContain(PREVIEW_BUDGET.thumbPx.hover);
    expect(allowlisted).toContain(PREVIEW_BUDGET.thumbPx.modal);
  });

  test("the inline ceiling stays under the existing download memory limit", () => {
    // `downloadFile` refuses above 32 MiB; an inline preview must not be the
    // thing that blows past it.
    expect(PREVIEW_BUDGET.inlineMax).toBeLessThan(32 * 1024 * 1024);
  });
});

describe("kind predicates", () => {
  test("native kinds are the ones the browser draws itself", () => {
    expect(isNativeKind("image")).toBe(true);
    expect(isNativeKind("pdf")).toBe(true);
    expect(isNativeKind("quicklook")).toBe(false);
    expect(isNativeKind("none")).toBe(false);
  });

  test("text kinds decode to a string rather than an object URL", () => {
    expect(isTextKind("code")).toBe(true);
    expect(isTextKind("markdown")).toBe(true);
    expect(isTextKind("image")).toBe(false);
  });
});
