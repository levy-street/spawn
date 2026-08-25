import { act, renderHook, waitFor } from "@testing-library/react-native";

import {
  landOnRoot,
  type NavigationContainer,
  popEveryStackToTop,
  stackKeysWithHistory,
  useCardAnimation,
} from "@/components/nav/navigation-reset";

/** A terminal over a host over the tabs, with a settings page open in its tab. */
const DEEP_STATE = {
  type: "stack",
  key: "root",
  index: 1,
  routes: [
    {
      name: "(drawer)",
      state: {
        type: "stack",
        key: "drawer",
        index: 1,
        routes: [
          {
            name: "(tabs)",
            state: {
              type: "tab",
              key: "tabs",
              index: 2,
              routes: [
                { name: "workspaces" },
                // A tab never visited has no navigator state of its own yet.
                { name: "hosts", state: { routes: [{ name: "index" }] } },
                {
                  name: "settings",
                  state: {
                    type: "stack",
                    key: "settings",
                    index: 1,
                    routes: [{ name: "index" }, { name: "devices" }],
                  },
                },
              ],
            },
          },
          { name: "host/[id]/index" },
        ],
      },
    },
    { name: "terminal/[sessionId]" },
  ],
} as unknown as Parameters<typeof stackKeysWithHistory>[0];

function container(state: unknown, ready = true): NavigationContainer & { dispatch: jest.Mock } {
  return {
    dispatch: jest.fn(),
    getRootState: () => state as ReturnType<NavigationContainer["getRootState"]>,
    isReady: () => ready,
  };
}

describe("landing on a root", () => {
  it("finds every stack with something pushed, outermost first", () => {
    expect(stackKeysWithHistory(DEEP_STATE)).toEqual(["root", "drawer", "settings"]);
  });

  it("pops each of them to its first screen, by name", () => {
    const nav = container(DEEP_STATE);
    expect(popEveryStackToTop(nav)).toBe(3);
    expect(nav.dispatch.mock.calls.map(([action]) => action)).toEqual([
      expect.objectContaining({ type: "POP_TO_TOP", target: "root" }),
      expect.objectContaining({ type: "POP_TO_TOP", target: "drawer" }),
      expect.objectContaining({ type: "POP_TO_TOP", target: "settings" }),
    ]);
  });

  it("dispatches nothing when there is nothing above the roots, or no navigator yet", () => {
    const flat = container({ type: "stack", key: "root", index: 0, routes: [{ name: "x" }] });
    expect(popEveryStackToTop(flat)).toBe(0);
    expect(flat.dispatch).not.toHaveBeenCalled();
    const unready = container(DEEP_STATE, false);
    expect(popEveryStackToTop(unready)).toBe(0);
    expect(unready.dispatch).not.toHaveBeenCalled();
  });

  it("holds the card animation off while it lands, and gives it back after", async () => {
    const nav = container(DEEP_STATE);
    const switchTab = jest.fn();
    const { result } = await renderHook(() => useCardAnimation());
    expect(result.current).toBe("simple_push");
    // What the stacks were animating with at the moment each pop reached them.
    const animationAtPop: string[] = [];
    nav.dispatch.mockImplementation(() => {
      animationAtPop.push(result.current);
    });

    let landing: Promise<void> = Promise.resolve();
    await act(async () => {
      landing = landOnRoot(nav, switchTab);
    });
    expect(result.current).toBe("none");

    await act(async () => {
      await landing;
    });
    expect(switchTab).toHaveBeenCalledTimes(1);
    // Off before anything is popped, so the pops arrive under a stack that no
    // longer animates them — and back once they have landed.
    expect(animationAtPop).toEqual(["none", "none", "none"]);
    await waitFor(() => expect(result.current).toBe("simple_push"));
  });
});
