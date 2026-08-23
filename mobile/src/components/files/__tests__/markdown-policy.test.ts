import {
  hardenMarkdownInline,
  parseMarkdown,
  safeMarkdownUrl,
} from "@/components/files/markdown-policy";

describe("Markdown security policy", () => {
  it("allows only http, https, and mailto URLs", () => {
    expect(safeMarkdownUrl("https://spawn.dev")).toBe("https://spawn.dev");
    expect(safeMarkdownUrl("mailto:hello@example.com")).toBe("mailto:hello@example.com");
    expect(safeMarkdownUrl("javascript:alert(1)")).toBeNull();
    expect(safeMarkdownUrl("data:text/html,bad")).toBeNull();
    expect(safeMarkdownUrl("/relative")).toBeNull();
  });

  it("suppresses remote images and strips unsafe link destinations", () => {
    expect(hardenMarkdownInline("![diagram](https://example.com/x.png)")).toBe("[Image: diagram]");
    expect(hardenMarkdownInline("[open](javascript:alert(1))")).toBe("open)");
  });

  it("leaves raw HTML inert and parses bounded GFM-shaped blocks", () => {
    const blocks = parseMarkdown(
      "# Title\n\n<script>alert(1)</script>\n\n- [x] done\n- [ ] later\n\nA | B\n--- | ---\n1 | 2",
    );
    expect(blocks).toEqual(
      expect.arrayContaining([
        { kind: "heading", level: 1, text: "Title" },
        { kind: "paragraph", text: "<script>alert(1)</script>" },
        { kind: "list", ordered: false, items: ["[x] done", "[ ] later"] },
        {
          kind: "table",
          rows: [
            ["A", "B"],
            ["1", "2"],
          ],
        },
      ]),
    );
  });
});
