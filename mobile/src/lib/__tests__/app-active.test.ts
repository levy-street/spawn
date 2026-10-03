import { act, renderHook } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";

import { useAppActive } from "@/lib/app-active";

const listeners = new Set<(state: AppStateStatus) => void>();
let initial: AppStateStatus;

beforeEach(() => {
  initial = AppState.currentState;
  AppState.currentState = "active";
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  });
});

afterEach(() => {
  AppState.currentState = initial;
  listeners.clear();
  jest.restoreAllMocks();
});

async function appGoes(state: AppStateStatus): Promise<void> {
  await act(async () => {
    AppState.currentState = state;
    for (const listener of [...listeners]) listener(state);
  });
}

test("is false only once the OS has sent the app to the background", async () => {
  const { result, unmount } = await renderHook(useAppActive);
  expect(result.current).toBe(true);

  await appGoes("inactive");
  expect(result.current).toBe(true);

  await appGoes("background");
  expect(result.current).toBe(false);

  await appGoes("active");
  expect(result.current).toBe(true);

  await unmount();
  expect(listeners.size).toBe(0);
});

test("starts false in an app launched into the background", async () => {
  AppState.currentState = "background";
  const { result } = await renderHook(useAppActive);
  expect(result.current).toBe(false);
});
