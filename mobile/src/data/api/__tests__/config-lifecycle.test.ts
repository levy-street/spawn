test("a late initial URL read cannot undo an explicit server switch", async () => {
  let fresh!: typeof import("@/data/api/config");
  let storage!: typeof import("@react-native-async-storage/async-storage").default;
  jest.isolateModules(() => {
    const loaded = require("@react-native-async-storage/async-storage");
    storage = loaded.default ?? loaded;
    fresh = require("@/data/api/config");
  });
  let resolve!: (value: string | null) => void;
  const oldRead = new Promise<string | null>((yes) => {
    resolve = yes;
  });
  jest.mocked(storage.getItem).mockReturnValueOnce(oldRead);
  const first = fresh.getBaseUrl();
  await new Promise<void>((done) => setImmediate(done));
  await fresh.setBaseUrl("https://new-origin.spawn.test");
  resolve("https://old-origin.spawn.test");
  await first;
  await expect(fresh.getBaseUrl()).resolves.toBe("https://new-origin.spawn.test");
});

test("overlapping server writes persist the latest selection after relaunch", async () => {
  let fresh!: typeof import("@/data/api/config");
  let storage!: typeof import("@react-native-async-storage/async-storage").default;
  jest.isolateModules(() => {
    const loaded = require("@react-native-async-storage/async-storage");
    storage = loaded.default ?? loaded;
    fresh = require("@/data/api/config");
  });
  let resolve!: () => void;
  let persisted: string | null = null;
  const slowWrite = new Promise<void>((yes) => {
    resolve = yes;
  });
  jest.mocked(storage.setItem).mockImplementation(async (_key, value) => {
    if (value.includes("old-origin")) await slowWrite;
    persisted = value;
  });
  const old = fresh.setBaseUrl("https://old-origin.spawn.test");
  await new Promise<void>((done) => setImmediate(done));
  const current = fresh.setBaseUrl("https://new-origin.spawn.test");
  await new Promise<void>((done) => setImmediate(done));
  resolve();
  await Promise.all([old, current]);
  await expect(fresh.getBaseUrl()).resolves.toBe("https://new-origin.spawn.test");
  expect(persisted).toBe("https://new-origin.spawn.test");
});
