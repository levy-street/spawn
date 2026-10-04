import { act, renderHook } from "@testing-library/react-native";

let mockAccount: string | null = "account-a";
const mockListeners = new Set<() => void>();

jest.mock("@/lib/crypto/identity", () => ({
  activeDeviceIdentityAccount: () => mockAccount,
  subscribeDeviceIdentityAccount: (listener: () => void) => {
    mockListeners.add(listener);
    return () => mockListeners.delete(listener);
  },
}));

import {
  recordHostCapabilities,
  resetHostCapabilities,
  useHostCapabilities,
  useHostOffers,
} from "@/data/stores/host-capabilities";
import {
  LAST_WORKSPACE_KEY,
  readLastWorkspace,
  rememberLastWorkspace,
} from "@/data/stores/last-workspace";

describe("what each host last advertised", () => {
  beforeEach(() => {
    mockAccount = "account-a";
    resetHostCapabilities();
  });

  test("nothing is known before a hello, and the hello is kept after", async () => {
    const { result } = await renderHook(() => useHostCapabilities("host-1"));
    expect(result.current).toBeNull();
    await act(async () => recordHostCapabilities("host-1", ["fs.list", "screen.v1"]));
    expect(result.current).toEqual(["fs.list", "screen.v1"]);
  });

  test("a hello is the signed-in account's own", async () => {
    recordHostCapabilities("host-1", ["screen.v1"]);
    const { result } = await renderHook(() => useHostCapabilities("host-1"));
    expect(result.current).toEqual(["screen.v1"]);

    await act(async () => {
      mockAccount = "account-b";
      for (const listener of mockListeners) listener();
    });
    expect(result.current).toBeNull();
  });

  test("a hello lights only what this build has a view for", async () => {
    recordHostCapabilities("host-1", ["screen.v1", "conv.v2", "agent.accounts.v1", "box.v1"]);
    const { result } = await renderHook(() => useHostOffers("host-1"));
    expect(result.current.slots.map((slot) => slot.id)).toEqual(["moves"]);
    expect(result.current.has("desktop")).toBe(false);
  });

  test("the same hello again changes nothing", async () => {
    recordHostCapabilities("host-1", ["fs.list"]);
    const { result } = await renderHook(() => useHostCapabilities("host-1"));
    const first = result.current;
    await act(async () => recordHostCapabilities("host-1", ["fs.list"]));
    expect(result.current).toBe(first);
  });
});

describe("the workspace used last", () => {
  test("is read back by the browser's key, and a storage fault reads as none", async () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => stored.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        stored.set(key, value);
      },
    };
    rememberLastWorkspace("workspace-1", storage);
    await Promise.resolve();
    expect(stored.get(LAST_WORKSPACE_KEY)).toBe("workspace-1");
    expect(LAST_WORKSPACE_KEY).toBe("spawn.workspaces.last");
    await expect(readLastWorkspace(storage)).resolves.toBe("workspace-1");
    await expect(
      readLastWorkspace({
        getItem: async () => {
          throw new Error("unavailable");
        },
        setItem: async () => undefined,
      }),
    ).resolves.toBeNull();
  });
});
