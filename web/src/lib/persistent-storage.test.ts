import { afterEach, expect, test } from "bun:test";
import {
  askToKeepDeviceStorage,
  deviceStoragePersistence,
  keepDeviceStorage,
  resetDeviceStoragePersistenceForTest,
} from "./persistent-storage";

function storage(persisted: boolean, grant: boolean) {
  const calls = { persist: 0 };
  return {
    calls,
    manager: {
      persisted: async () => persisted,
      persist: async () => {
        calls.persist++;
        return grant;
      },
    },
  };
}

afterEach(() => resetDeviceStoragePersistenceForTest());

test("asks for persistent storage when the origin does not have it", async () => {
  const { calls, manager } = storage(false, true);
  expect(await keepDeviceStorage(manager)).toBe("granted");
  expect(calls.persist).toBe(1);
});

test("does not ask again once storage is persistent", async () => {
  const { calls, manager } = storage(true, true);
  expect(await keepDeviceStorage(manager)).toBe("granted");
  expect(calls.persist).toBe(0);
});

test("a refusal and a failure are both refusals; a browser without the API is unsupported", async () => {
  expect(await keepDeviceStorage(storage(false, false).manager)).toBe("refused");
  expect(
    await keepDeviceStorage({
      persisted: async () => false,
      persist: async () => {
        throw new Error("denied");
      },
    }),
  ).toBe("refused");
  expect(await keepDeviceStorage(undefined)).toBe("unsupported");
});

test("the answer is kept for the UI instead of thrown away (#121)", async () => {
  expect(deviceStoragePersistence()).toBeNull();
  expect(await askToKeepDeviceStorage(storage(false, false).manager)).toBe("refused");
  expect(deviceStoragePersistence()).toBe("refused");
});

test("asking again after the browser changed its mind replaces a refusal with the grant", async () => {
  await askToKeepDeviceStorage(storage(false, false).manager);
  expect(deviceStoragePersistence()).toBe("refused");
  // Notification permission was granted in between: Chrome now says yes.
  await askToKeepDeviceStorage(storage(false, true).manager);
  expect(deviceStoragePersistence()).toBe("granted");
});
