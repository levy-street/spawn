import {
  LayoutV3ParseError,
  parseLayoutV3,
  serializeLayoutV3,
  validateLayoutV3,
} from "@/data/layout/layout-v3";
import type { WorkspaceLayoutV3 } from "@/data/types/layout";

const DOCUMENT: WorkspaceLayoutV3 = {
  version: 3,
  active_tab: "tab-1",
  vendor_extension: { retained: true },
  tabs: [
    {
      id: "tab-1",
      name: "Tab 1",
      host_id: null,
      cwd: null,
      tab_extension: "keep",
      layout: {
        version: 3,
        tiles: [
          {
            session_id: "future-widget",
            x: 0,
            y: 0,
            w: 24,
            h: 24,
            tile_extension: 42,
            widget: { kind: "future-widget", payload: { untouched: true } },
          },
        ],
      },
    },
  ],
};

describe("LayoutV3 envelope codec", () => {
  it("round-trips all known and unknown payload fields", () => {
    const decoded = parseLayoutV3(serializeLayoutV3(DOCUMENT));

    expect(decoded).toEqual(DOCUMENT);
    expect(decoded).not.toBe(DOCUMENT);
    expect(decoded.tabs[0]?.layout.tiles[0]?.widget).not.toBe(
      DOCUMENT.tabs[0]?.layout.tiles[0]?.widget,
    );
  });

  it("normalizes omitted tab homes to null without mutating input", () => {
    const input = {
      version: 3,
      active_tab: "tab-1",
      tabs: [{ id: "tab-1", name: "Tab 1", layout: { version: 3, tiles: [] } }],
    };

    expect(parseLayoutV3(input).tabs[0]).toMatchObject({ host_id: null, cwd: null });
    expect(input.tabs[0]).not.toHaveProperty("host_id");
  });

  it.each([
    ["bad version", { ...DOCUMENT, version: 2 }],
    ["missing tabs", { version: 3, active_tab: null }],
    ["empty tabs", { version: 3, active_tab: null, tabs: [] }],
    ["unknown active tab", { ...DOCUMENT, active_tab: "missing" }],
    [
      "invalid geometry",
      {
        ...DOCUMENT,
        tabs: [
          {
            ...DOCUMENT.tabs[0],
            layout: { version: 3, tiles: [{ session_id: "bad", x: 0, y: 0, w: 2, h: 2 }] },
          },
        ],
      },
    ],
  ])("rejects %s", (_label, value) => {
    expect(validateLayoutV3(value).ok).toBe(false);
    expect(() => parseLayoutV3(value)).toThrow(LayoutV3ParseError);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseLayoutV3("{")).toThrow(LayoutV3ParseError);
  });
});
