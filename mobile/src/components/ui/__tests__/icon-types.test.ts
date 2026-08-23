import type { IconName } from "@/components/ui/icon";

describe("IconName", () => {
  it("contains the researched Lucide catalog and rejects unknown names", () => {
    const terminal: IconName = "Terminal";
    expect(terminal).toBe("Terminal");

    // @ts-expect-error Icon names are deliberately limited to the web catalog.
    const unknown: IconName = "DefinitelyNotASpawnIcon";
    expect(unknown).toBe("DefinitelyNotASpawnIcon");
  });
});
