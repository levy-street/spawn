import { authToken } from "@/data/api/auth-token";

jest.mock("@/lib/secure-storage", () => {
  const store = new Map<string, string>();
  return {
    secureStorage: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    },
  };
});

// A login stores a token but performs no navigation of its own that would force
// the gate to re-read it. Without a change notification the gate keeps its
// launch-time answer and bounces the user straight back to the login screen.
describe("auth token change notification", () => {
  it("notifies subscribers when a token is stored", async () => {
    const seen: string[] = [];
    const unsubscribe = authToken.subscribe(() => seen.push("changed"));
    await authToken.set(
      // header.payload.signature with an exp far in the future
      `a.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.b`,
    );
    expect(seen).toEqual(["changed"]);
    unsubscribe();
  });

  it("notifies subscribers when credentials are cleared", async () => {
    const seen: string[] = [];
    const unsubscribe = authToken.subscribe(() => seen.push("changed"));
    await authToken.clear();
    expect(seen).toEqual(["changed"]);
    unsubscribe();
  });

  it("stops notifying after unsubscribe", async () => {
    const seen: string[] = [];
    authToken.subscribe(() => seen.push("changed"))();
    await authToken.clear();
    expect(seen).toEqual([]);
  });

  it("keeps notifying the other listeners when one throws", async () => {
    const seen: string[] = [];
    const un1 = authToken.subscribe(() => {
      throw new Error("bad listener");
    });
    const un2 = authToken.subscribe(() => seen.push("changed"));
    await authToken.clear();
    expect(seen).toEqual(["changed"]);
    un1();
    un2();
  });
});
