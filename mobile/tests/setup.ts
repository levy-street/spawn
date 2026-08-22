import "@testing-library/react-native";
import "react-native-gesture-handler/jestSetup";
import { setUpTests } from "react-native-reanimated";

setUpTests();

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
