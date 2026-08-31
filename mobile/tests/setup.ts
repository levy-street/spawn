import "@testing-library/react-native";
import "react-native-gesture-handler/jestSetup";
import { setUpTests } from "react-native-reanimated";

setUpTests();

function networkTarget(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

globalThis.fetch = (async (input) => {
  throw new Error(`Network access is disabled in tests: ${networkTarget(input)}`);
}) as typeof fetch;

class BlockedWebSocket {
  constructor(url: string | URL) {
    throw new Error(`WebSocket access is disabled in tests: ${url.toString()}`);
  }
}

globalThis.WebSocket = BlockedWebSocket as unknown as typeof WebSocket;

afterEach(() => {
  jest.useRealTimers();
});

jest.mock("@react-native-async-storage/async-storage", () => ({
  clear: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
  getItem: jest.fn(async () => null),
  multiGet: jest.fn(async () => []),
  multiRemove: jest.fn(async () => undefined),
  multiSet: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  setItem: jest.fn(async () => undefined),
}));

jest.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: {
    Light: "light",
    Medium: "medium",
    Heavy: "heavy",
    Soft: "soft",
    Rigid: "rigid",
  },
  NotificationFeedbackType: {
    Success: "success",
    Warning: "warning",
    Error: "error",
  },
  impactAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  selectionAsync: jest.fn(async () => undefined),
  performAndroidHapticsAsync: jest.fn(async () => undefined),
}));

jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK: "afterFirstUnlock",
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "afterFirstUnlockThisDeviceOnly",
  ALWAYS: "always",
  ALWAYS_THIS_DEVICE_ONLY: "alwaysThisDeviceOnly",
  WHEN_UNLOCKED: "whenUnlocked",
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  canUseBiometricAuthentication: jest.fn(() => false),
  deleteItemAsync: jest.fn(async () => undefined),
  getItemAsync: jest.fn(async () => null),
  isAvailableAsync: jest.fn(async () => true),
  setItemAsync: jest.fn(async () => undefined),
}));

/**
 * There is no native keyboard behind this library in a test runner, so importing
 * it for real throws "doesn't seem to be linked" before a component can render.
 * This is the quiet default — a keyboard that is never up. A test that needs to
 * drive one mocks the module itself, which takes precedence over this.
 */
jest.mock("react-native-keyboard-controller", () => {
  const { View } = require("react-native") as typeof import("react-native");
  return {
    KeyboardController: {
      dismiss: jest.fn(async () => undefined),
      setInputMode: jest.fn(),
      setDefaultMode: jest.fn(),
    },
    KeyboardProvider: ({ children }: { children: React.ReactNode }) => children,
    KeyboardAwareScrollView: View,
    useGenericKeyboardHandler: jest.fn(),
    useKeyboardState: (selector?: (state: { isVisible: boolean; height: number }) => unknown) => {
      const state = { isVisible: false, height: 0 };
      return selector ? selector(state) : state;
    },
    useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
  };
});

/**
 * The WebView library reaches for its native module at import time, so any file
 * that transitively imports a host transport surface dies before a test can
 * run. Nothing in a test drives a terminal worker, so the view is inert here —
 * a test that needs one mocks the module itself, which takes precedence.
 */
jest.mock("react-native-webview", () => {
  const { View } = require("react-native") as typeof import("react-native");
  return { __esModule: true, default: View, WebView: View };
});
