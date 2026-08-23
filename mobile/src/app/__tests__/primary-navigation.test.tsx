import { existsSync } from "node:fs";
import { join } from "node:path";

import { Stack } from "expo-router";
import { act, fireEvent, renderRouter } from "expo-router/testing-library";
import { Text, View } from "react-native";

import TabsLayout from "@/app/(drawer)/(tabs)/_layout";
import HostsStackLayout from "@/app/(drawer)/(tabs)/hosts/_layout";
import SettingsStackLayout from "@/app/(drawer)/(tabs)/settings/_layout";
import WorkspacesStackLayout from "@/app/(drawer)/(tabs)/workspaces/_layout";
import { BottomNav } from "@/components/nav/bottom-nav";
import { ROUNDED_CARD_GESTURE_OPTIONS } from "@/components/nav/navigation-options";
import { ThemeProvider } from "@/theme";

const APP_DIR = join(__dirname, "..");

interface NavigationState {
  index?: number;
  routes: { name: string; state?: NavigationState }[];
  type?: string;
}

function screenFor(label: string) {
  return function StubScreen(): React.JSX.Element {
    return (
      <View>
        <Text testID={`screen-${label}`}>{label}</Text>
      </View>
    );
  };
}

/**
 * The real navigators for the three roots, with stubbed leaves. Only the shape
 * is under test: whether a nav tap switches tabs or stacks a card on top of the
 * screen you were on.
 */
const ROUTES = {
  _layout: () => (
    <ThemeProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </ThemeProvider>
  ),
  index: screenFor("index"),
  "(drawer)/_layout": () => (
    <>
      <Stack screenOptions={{ ...ROUNDED_CARD_GESTURE_OPTIONS, headerShown: false }}>
        <Stack.Screen name="(tabs)" options={{ animation: "none", gestureEnabled: false }} />
        <Stack.Screen name="workspace/[id]" />
      </Stack>
      <BottomNav />
    </>
  ),
  "(drawer)/(tabs)/_layout": TabsLayout,
  "(drawer)/(tabs)/workspaces/_layout": WorkspacesStackLayout,
  "(drawer)/(tabs)/workspaces/index": screenFor("workspaces"),
  "(drawer)/(tabs)/hosts/_layout": HostsStackLayout,
  "(drawer)/(tabs)/hosts/index": screenFor("hosts"),
  "(drawer)/(tabs)/settings/_layout": SettingsStackLayout,
  "(drawer)/(tabs)/settings/index": screenFor("settings"),
  "(drawer)/workspace/[id]": screenFor("workspace-detail"),
};

function findState(state: NavigationState | undefined, name: string): NavigationState | undefined {
  if (!state) return undefined;
  for (const route of state.routes) {
    if (route.name === name) return route.state;
    const nested = findState(route.state, name);
    if (nested) return nested;
  }
  return undefined;
}

async function renderShell() {
  const rendered = renderRouter(ROUTES, { initialUrl: "/workspaces" });
  const view = await rendered;
  return { rendered, view };
}

describe("primary navigation", () => {
  it.each(["Hosts", "Settings"])(
    "opens %s as a tab, never as a card over the screen you were on",
    async (label) => {
      const { rendered, view } = await renderShell();

      await act(async () => {
        fireEvent.press(view.getByLabelText(label));
      });

      expect(rendered.getPathname()).toBe(`/${label.toLowerCase()}`);

      // The regression this guards: when the three roots were siblings of the
      // detail screens, a nav tap pushed a card and left the previous root
      // underneath it, back-swipe and all.
      const drawer = findState(rendered.getRouterState() as NavigationState, "(drawer)");
      expect(drawer?.routes.map((route) => route.name)).toEqual(["(tabs)"]);

      const tabs = findState(rendered.getRouterState() as NavigationState, "(tabs)");
      expect(tabs?.type).toBe("tab");
      expect(tabs?.routes.map((route) => route.name)).toEqual(["workspaces", "hosts", "settings"]);
    },
  );

  it("returns to workspaces without stacking either", async () => {
    const { rendered, view } = await renderShell();

    await act(async () => {
      fireEvent.press(view.getByLabelText("Settings"));
    });
    await act(async () => {
      fireEvent.press(view.getByLabelText("Workspaces"));
    });

    expect(rendered.getPathname()).toBe("/workspaces");
    const drawer = findState(rendered.getRouterState() as NavigationState, "(drawer)");
    expect(drawer?.routes.map((route) => route.name)).toEqual(["(tabs)"]);
  });

  it.each(["workspaces", "hosts", "settings"])("keeps %s inside the tab group on disk", (root) => {
    expect(existsSync(join(APP_DIR, "(drawer)", "(tabs)", root, "index.tsx"))).toBe(true);
    expect(existsSync(join(APP_DIR, "(drawer)", root))).toBe(false);
  });
});
