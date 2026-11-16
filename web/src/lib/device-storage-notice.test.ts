import { expect, test } from "bun:test";
import { type DeviceStorageNoticeFacts, deviceStorageNoticeWanted } from "./device-storage-notice";

const atRisk: DeviceStorageNoticeFacts = {
  persistence: "refused",
  hasPasskey: false,
  approved: true,
  dismissed: false,
  desktopShell: false,
};

test("a refusing browser on an account without a passkey is told once", () => {
  expect(deviceStorageNoticeWanted(atRisk)).toBe(true);
});

test("nothing is shown when the browser keeps its storage, or was never asked", () => {
  expect(deviceStorageNoticeWanted({ ...atRisk, persistence: "granted" })).toBe(false);
  expect(deviceStorageNoticeWanted({ ...atRisk, persistence: "unsupported" })).toBe(false);
  expect(deviceStorageNoticeWanted({ ...atRisk, persistence: null })).toBe(false);
});

test("nothing is shown when the account already has a passkey, or before that is known", () => {
  expect(deviceStorageNoticeWanted({ ...atRisk, hasPasskey: true })).toBe(false);
  expect(deviceStorageNoticeWanted({ ...atRisk, hasPasskey: null })).toBe(false);
});

test("a browser that is registered but not approved is left to the waiting card", () => {
  expect(deviceStorageNoticeWanted({ ...atRisk, approved: false })).toBe(false);
  expect(deviceStorageNoticeWanted({ ...atRisk, approved: null })).toBe(false);
});

test("a dismissal is final in this browser, and the desktop app never shows it", () => {
  expect(deviceStorageNoticeWanted({ ...atRisk, dismissed: true })).toBe(false);
  expect(deviceStorageNoticeWanted({ ...atRisk, desktopShell: true })).toBe(false);
});
