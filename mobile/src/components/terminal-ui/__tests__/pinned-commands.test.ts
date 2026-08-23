import {
  DEFAULT_PINNED_COMMANDS,
  loadPinnedCommands,
  MAX_PINNED_COMMANDS,
  type PinnedCommandStorage,
  parsePinnedCommands,
  resetPinnedCommandsCache,
  savePinnedCommands,
  togglePinnedCommand,
} from "@/components/terminal-ui/pinned-commands";
import { resolvePinnedCommands } from "@/components/terminal-ui/terminal-commands";

function storage(initial: string | null): PinnedCommandStorage & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    getItem: async () => initial,
    setItem: async (_key, value) => {
      written.push(value);
    },
  };
}

beforeEach(() => {
  resetPinnedCommandsCache();
});

describe("stored pins", () => {
  test("starts every agent with keys that resolve to real ones", () => {
    for (const [kind, ids] of Object.entries(DEFAULT_PINNED_COMMANDS)) {
      const resolved = resolvePinnedCommands(
        kind as keyof typeof DEFAULT_PINNED_COMMANDS,
        ids as string[],
      );
      expect(resolved.map((command) => command.id)).toEqual(ids);
    }
  });

  test("falls back to the defaults for anything unreadable", () => {
    expect(parsePinnedCommands(null)).toEqual(DEFAULT_PINNED_COMMANDS);
    expect(parsePinnedCommands("not json")).toEqual(DEFAULT_PINNED_COMMANDS);
    expect(parsePinnedCommands('["key-Escape"]')).toEqual(DEFAULT_PINNED_COMMANDS);
  });

  test("keeps a deliberately emptied strip empty rather than restoring defaults", () => {
    expect(parsePinnedCommands('{"shell":[]}').shell).toEqual([]);
    // An agent the stored file says nothing about still gets its defaults.
    expect(parsePinnedCommands('{"shell":[]}')["claude-code"]).toEqual(
      DEFAULT_PINNED_COMMANDS["claude-code"],
    );
  });

  test("drops junk entries, duplicates and anything past the cap", () => {
    const ids = Array.from({ length: MAX_PINNED_COMMANDS + 4 }, (_, index) => `key-${index}`);
    const parsed = parsePinnedCommands(
      JSON.stringify({ shell: [...ids, ...ids, 7, null, ""] }),
    ).shell;

    expect(parsed).toHaveLength(MAX_PINNED_COMMANDS);
    expect(parsed).toEqual(ids.slice(0, MAX_PINNED_COMMANDS));
  });

  test("survives a storage that throws rather than losing the terminal's strip", async () => {
    const failing: PinnedCommandStorage = {
      getItem: async () => {
        throw new Error("no disk");
      },
      setItem: async () => undefined,
    };
    await expect(loadPinnedCommands(failing)).resolves.toEqual(DEFAULT_PINNED_COMMANDS);
  });

  test("reads once and writes what it read back", async () => {
    const store = storage(JSON.stringify({ shell: ["ctrl-c"] }));
    const loaded = await loadPinnedCommands(store);
    expect(loaded.shell).toEqual(["ctrl-c"]);

    await savePinnedCommands({ ...loaded, shell: ["ctrl-c", "ctrl-l"] }, store);
    expect(JSON.parse(store.written[0] ?? "{}")).toMatchObject({ shell: ["ctrl-c", "ctrl-l"] });
  });
});

describe("toggling a pin", () => {
  test("adds to the tail and removes in place", () => {
    expect(togglePinnedCommand(["ctrl-c"], "ctrl-l")).toEqual({
      ids: ["ctrl-c", "ctrl-l"],
      changed: true,
    });
    expect(togglePinnedCommand(["ctrl-c", "ctrl-l"], "ctrl-c")).toEqual({
      ids: ["ctrl-l"],
      changed: true,
    });
  });

  test("refuses to grow past the cap, and says so rather than dropping one silently", () => {
    const full = Array.from({ length: MAX_PINNED_COMMANDS }, (_, index) => `key-${index}`);
    const result = togglePinnedCommand(full, "ctrl-c");

    expect(result).toEqual({ ids: full, changed: false });
    // Unpinning still works at the cap; only growing is refused.
    expect(togglePinnedCommand(full, "key-0").changed).toBe(true);
  });
});
