import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RouteTabs, Tabs } from "./tabs";

/** Each opening tag of an element, with its attributes. */
function tags(html: string, name: string): string[] {
  return html.match(new RegExp(`<${name}\\b[^>]*>`, "gu")) ?? [];
}

const SECTIONS = [
  { key: "overview", label: "Overview", href: "/hosts/mac" },
  { key: "files", label: "Files", href: "/hosts/mac/files" },
  { key: "sessions", label: "Sessions", href: "/hosts/mac/sessions" },
];

describe("RouteTabs", () => {
  test("every section link is in the Tab order, and the one on screen says so", () => {
    const html = renderToStaticMarkup(
      <RouteTabs label="Mac sections" tabs={SECTIONS} current="files" />,
    );
    expect(html).toContain('<nav aria-label="Mac sections"');
    const links = tags(html, "a");
    expect(links).toHaveLength(3);
    for (const link of links) expect(link).not.toContain("tabindex");
    expect(links.filter((link) => link.includes('aria-current="page"'))).toHaveLength(1);
    expect(links[1]).toContain('aria-current="page"');
  });

  test("a shut section stays in place, focusable, current when it is the one on screen", () => {
    const html = renderToStaticMarkup(
      <RouteTabs
        label="Mac sections"
        tabs={SECTIONS.map((tab) =>
          tab.key === "files" ? { ...tab, disabledReason: "Connections are blocked." } : tab,
        )}
        current="files"
      />,
    );
    const [button] = tags(html, "button");
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain('aria-current="page"');
    expect(button).not.toContain("tabindex");
    expect(html).toContain("Connections are blocked.");
    for (const link of tags(html, "a")) expect(link).not.toContain('aria-current="page"');
  });
});

describe("Tabs", () => {
  test("a pick-one switch is entered once, on the choice made", () => {
    const html = renderToStaticMarkup(
      <Tabs
        label="Install target"
        items={[
          { value: "mac", label: "Mac" },
          { value: "linux", label: "Linux" },
        ]}
        value="linux"
        onValueChange={() => {}}
      />,
    );
    const [mac, linux] = tags(html, "button");
    expect(mac).toContain('tabindex="-1"');
    expect(linux).toContain('tabindex="0"');
    expect(linux).toContain('aria-selected="true"');
  });
});
