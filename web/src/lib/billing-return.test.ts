import { describe, expect, test } from "bun:test";
import {
  BILLING_RETURN_KEY,
  carryBillingParam,
  parseBillingReturn,
  rememberBillingReturn,
  takeBillingReturn,
  withoutBillingParam,
} from "./billing-return";

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(seed));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("parseBillingReturn", () => {
  test("knows the three flags the server sends and nothing else", () => {
    expect(parseBillingReturn("?billing=complete")).toBe("complete");
    expect(parseBillingReturn("?billing=cancelled")).toBe("cancelled");
    expect(parseBillingReturn("?a=1&billing=portal")).toBe("portal");
    expect(parseBillingReturn("?billing=paid")).toBeNull();
    expect(parseBillingReturn("")).toBeNull();
  });
});

describe("withoutBillingParam", () => {
  test("drops the flag and keeps everything else", () => {
    expect(withoutBillingParam("/app", "?billing=complete")).toBe("/app");
    expect(withoutBillingParam("/legion", "?billing=portal&tab=2")).toBe("/legion?tab=2");
    expect(withoutBillingParam("/app", "")).toBe("/app");
  });
});

describe("the return note", () => {
  test("is written on the way out and torn up on the way back", () => {
    const storage = fakeStorage();
    rememberBillingReturn(storage, "/legion?x=1");
    expect(storage.getItem(BILLING_RETURN_KEY)).toBe("/legion?x=1");
    expect(takeBillingReturn(storage)).toBe("/legion?x=1");
    expect(takeBillingReturn(storage)).toBeNull();
  });

  test("only ever points at a same-origin path, coming and going", () => {
    const storage = fakeStorage();
    rememberBillingReturn(storage, "https://evil.test/");
    expect(storage.getItem(BILLING_RETURN_KEY)).toBe("/app");
    storage.setItem(BILLING_RETURN_KEY, "//evil.test");
    expect(takeBillingReturn(storage)).toBe("/app");
  });

  test("survives storage that refuses", () => {
    const broken = {
      ...fakeStorage(),
      setItem: () => {
        throw new Error("quota");
      },
      getItem: () => {
        throw new Error("blocked");
      },
    } as Storage;
    expect(() => rememberBillingReturn(broken, "/legion")).not.toThrow();
    expect(takeBillingReturn(broken)).toBeNull();
    expect(takeBillingReturn(null)).toBeNull();
  });
});

describe("carryBillingParam", () => {
  test("hands the flag on to the workspace redirect, and only the flag", () => {
    expect(carryBillingParam("/w/abc", "?billing=complete&x=1")).toBe("/w/abc?billing=complete");
    expect(carryBillingParam("/w/abc", "?x=1")).toBe("/w/abc");
    expect(carryBillingParam("/w/abc", "")).toBe("/w/abc");
  });
});
