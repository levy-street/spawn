import {
  classifyFile,
  extensionOf,
  PREVIEW_BUDGET,
  previewBudgetDecision,
} from "@/components/files/file-kinds";

describe("file preview classification", () => {
  test.each([
    ["photo.PNG", "image", "PNG image"],
    ["drawing.svg", "svg", "SVG image"],
    ["paper.pdf", "pdf", "PDF document"],
    ["clip.mp4", "video", "MPEG-4 video"],
    ["track.flac", "audio", "FLAC audio"],
    ["notes.txt", "text", "Plain text"],
    ["main.ts", "code", "TypeScript"],
    ["README.md", "markdown", "Markdown"],
    ["design.psd", "quicklook", "Photoshop document"],
    ["bundle.zip", "none", "Zip archive"],
  ])("classifies %s as %s", (name, kind, label) => {
    expect(classifyFile({ name, kind: "file" })).toMatchObject({ kind, label });
  });

  test.each([
    ["Dockerfile", "code", "shell"],
    ["CMakeLists.txt", "code", "shell"],
    [".gitignore", "code", "shell"],
    ["types.d.ts", "code", "ts"],
    ["app.min.js", "code", "js"],
    ["archive.tar.gz", "none", undefined],
    ["LICENSE-MIT", "text", undefined],
    ["CHANGELOG-2024", "text", undefined],
    ["unknown.xyz", "quicklook", undefined],
    ["extensionless", "text", undefined],
  ])("honours resolution order for %s", (name, kind, language) => {
    expect(classifyFile({ name, kind: "file" })).toMatchObject({
      kind,
      ...(language ? { language } : {}),
    });
  });

  it("fails closed for symlinks and special entries", () => {
    expect(classifyFile({ name: "folder", kind: "directory" }).label).toBe("Folder");
    expect(classifyFile({ name: "link", kind: "symlink" }).label).toBe("Symbolic link");
    expect(classifyFile({ name: "socket", kind: "other" }).label).toBe("Special file");
  });

  it("marks executable name classes", () => {
    expect(classifyFile({ name: "deploy.sh", kind: "file" }).executable).toBe(true);
    expect(classifyFile({ name: "shortcut.url", kind: "file" }).executable).toBe(true);
    expect(classifyFile({ name: "main.go", kind: "file" }).executable).toBeUndefined();
  });

  it("treats leading and trailing dots as part of extensionless names", () => {
    expect(extensionOf(".profile")).toBe("");
    expect(extensionOf("name.")).toBe("");
    expect(extensionOf("name.TS")).toBe("ts");
  });

  it("enforces automatic, inline, PDF, and media boundaries before fetching", () => {
    const text = classifyFile({ name: "notes.txt", kind: "file" });
    expect(previewBudgetDecision(PREVIEW_BUDGET.autoFetch, text)).toBe("auto");
    expect(previewBudgetDecision(PREVIEW_BUDGET.autoFetch + 1, text)).toBe("confirm");
    expect(previewBudgetDecision(PREVIEW_BUDGET.inlineMax, text)).toBe("confirm");
    expect(previewBudgetDecision(PREVIEW_BUDGET.inlineMax + 1, text)).toBe("blocked");

    const pdf = classifyFile({ name: "paper.pdf", kind: "file" });
    expect(previewBudgetDecision(PREVIEW_BUDGET.pdfMax, pdf)).toBe("confirm");
    expect(previewBudgetDecision(PREVIEW_BUDGET.pdfMax + 1, pdf)).toBe("blocked");

    const media = classifyFile({ name: "movie.mp4", kind: "file" });
    expect(previewBudgetDecision(PREVIEW_BUDGET.mediaMax, media)).toBe("confirm");
    expect(previewBudgetDecision(PREVIEW_BUDGET.mediaMax + 1, media)).toBe("blocked");
  });
});
