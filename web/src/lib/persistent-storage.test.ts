import { expect, test } from "bun:test";
import { keepDeviceStorage } from "./persistent-storage";

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

test("asks for persistent storage when the origin does not have it", async () => {
  const { calls, manager } = storage(false, true);
  expect(await keepDeviceStorage(manager)).toBe(true);
  expect(calls.persist).toBe(1);
});

test("does not ask again once storage is persistent", async () => {
  const { calls, manager } = storage(true, true);
  expect(await keepDeviceStorage(manager)).toBe(true);
  expect(calls.persist).toBe(0);
});

test("a refusal, a failure, or a browser without the API changes nothing", async () => {
  expect(await keepDeviceStorage(storage(false, false).manager)).toBe(false);
  expect(
    await keepDeviceStorage({
      persisted: async () => false,
      persist: async () => {
        throw new Error("denied");
      },
    }),
  ).toBe(false);
  expect(await keepDeviceStorage(undefined)).toBe(false);
});
