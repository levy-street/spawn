import {
  DEFAULT_FILE_VIEW_OPTIONS,
  FILE_VIEW_OPTIONS_KEY,
  parseFileViewOptions,
  resetExplorerPrefs,
  SHOW_HIDDEN_KEY,
  useExplorerPrefs,
} from "@/data/stores/explorer-prefs";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, next: string) => {
      values.set(key, next);
    }),
  };
}

beforeEach(() => resetExplorerPrefs());

describe("explorer view options", () => {
  test("hidden files are hidden, folders on top and sorted by name until the device says otherwise", () => {
    expect(DEFAULT_FILE_VIEW_OPTIONS).toEqual({
      sort: { key: "name", direction: "asc" },
      foldersFirst: true,
      showHidden: false,
    });
    expect(parseFileViewOptions(null)).toEqual({
      sort: { key: "name", direction: "asc" },
      foldersFirst: true,
    });
  });

  test("reads what was stored, and falls back field by field on anything malformed", () => {
    expect(
      parseFileViewOptions(
        JSON.stringify({ sort: { key: "modified", direction: "desc" }, foldersFirst: false }),
      ),
    ).toEqual({ sort: { key: "modified", direction: "desc" }, foldersFirst: false });
    const fallback = { sort: { key: "name", direction: "asc" }, foldersFirst: true };
    expect(
      parseFileViewOptions(
        JSON.stringify({ sort: { key: "path", direction: "up" }, foldersFirst: 1 }),
      ),
    ).toEqual(fallback);
    expect(parseFileViewOptions(JSON.stringify({ foldersFirst: false }))).toEqual({
      ...fallback,
      foldersFirst: false,
    });
    expect(parseFileViewOptions("{nope")).toEqual(fallback);
    expect(parseFileViewOptions("[]")).toEqual(fallback);
  });

  test("hydrates once from the device and writes every change back", async () => {
    const storage = memoryStorage({
      [FILE_VIEW_OPTIONS_KEY]: JSON.stringify({
        sort: { key: "size", direction: "desc" },
        foldersFirst: false,
      }),
      [SHOW_HIDDEN_KEY]: "true",
    });
    await useExplorerPrefs.getState().hydrate(storage);
    await useExplorerPrefs.getState().hydrate(storage);
    expect(storage.getItem).toHaveBeenCalledTimes(2);
    expect(useExplorerPrefs.getState()).toMatchObject({
      hydrated: true,
      showHidden: true,
      foldersFirst: false,
      sort: { key: "size", direction: "desc" },
    });

    useExplorerPrefs.getState().setShowHidden(false, storage);
    useExplorerPrefs.getState().setSort({ key: "kind", direction: "asc" }, storage);
    useExplorerPrefs.getState().setFoldersFirst(true, storage);
    expect(storage.setItem).toHaveBeenCalledWith(SHOW_HIDDEN_KEY, "false");
    expect(storage.setItem).toHaveBeenLastCalledWith(
      FILE_VIEW_OPTIONS_KEY,
      JSON.stringify({ sort: { key: "kind", direction: "asc" }, foldersFirst: true }),
    );
  });

  test("Show hidden files is the folder picker's switch: the same key, the same words", async () => {
    // What the launcher's folder picker wrote is what the file browser shows.
    await useExplorerPrefs.getState().hydrate(memoryStorage({ [SHOW_HIDDEN_KEY]: "true" }));
    expect(useExplorerPrefs.getState().showHidden).toBe(true);
    expect(SHOW_HIDDEN_KEY).toBe("spawn.folderPicker.showHidden");
  });

  test("a choice made while the stored ones are still loading wins, and only that one", async () => {
    let release: (value: string | null) => void = () => undefined;
    const storage = {
      getItem: jest.fn((key: string) =>
        key === SHOW_HIDDEN_KEY
          ? new Promise<string | null>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(JSON.stringify({ sort: { key: "size", direction: "asc" } })),
      ),
      setItem: jest.fn(async () => undefined),
    };
    const hydrating = useExplorerPrefs.getState().hydrate(storage);
    useExplorerPrefs.getState().setShowHidden(true, storage);
    release("false");
    await hydrating;
    expect(useExplorerPrefs.getState()).toMatchObject({
      showHidden: true,
      sort: { key: "size", direction: "asc" },
    });
  });
});
