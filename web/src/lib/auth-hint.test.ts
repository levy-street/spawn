import { describe, expect, it } from "bun:test";
import { readSignedInHint, SIGNED_IN_HINT_KEY, writeSignedInHint } from "./auth-hint";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

describe("the signed-in hint", () => {
  it("is absent until a session has been seen", () => {
    expect(readSignedInHint(fakeStorage())).toBe(false);
    expect(readSignedInHint(null)).toBe(false);
  });

  it("is written by a yes and cleared by a no", () => {
    const s = fakeStorage();
    writeSignedInHint(true, s);
    expect(s.map.get(SIGNED_IN_HINT_KEY)).toBe("1");
    expect(readSignedInHint(s)).toBe(true);
    writeSignedInHint(false, s);
    expect(readSignedInHint(s)).toBe(false);
  });

  it("survives a storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readSignedInHint(broken)).toBe(false);
    expect(() => writeSignedInHint(true, broken)).not.toThrow();
  });
});
