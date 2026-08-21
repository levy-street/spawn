import assert from "node:assert/strict";
import { viewportInset } from "./viewport";

declare function describe(name: string, callback: () => void): void;
declare function test(name: string, callback: () => void | Promise<void>): void;

describe("viewportInset", () => {
  test("leaves the layout to 100dvh when nothing is covering it", () => {
    assert.deepEqual(
      viewportInset({ visualHeight: 800, offsetTop: 0, scale: 1, layoutHeight: 800 }),
      { height: null, keyboard: 0 },
    );
  });

  test("shrinks to the visual viewport when the keyboard is open", () => {
    assert.deepEqual(
      viewportInset({ visualHeight: 460, offsetTop: 0, scale: 1, layoutHeight: 800 }),
      { height: 460, keyboard: 340 },
    );
  });

  test("keeps filling the page when pinch zoomed", () => {
    // At 1.5x the visual viewport reports 533px of an 800px page; sizing the
    // shell off that pulls the app up and leaves 267px of the page bare.
    assert.deepEqual(
      viewportInset({ visualHeight: 533.33, offsetTop: 0, scale: 1.5, layoutHeight: 800 }),
      { height: null, keyboard: 0 },
    );
  });

  test("reports no keyboard while panning a zoomed page", () => {
    assert.deepEqual(
      viewportInset({ visualHeight: 400, offsetTop: 400, scale: 2, layoutHeight: 800 }),
      { height: null, keyboard: 0 },
    );
  });

  test("ignores the sub-pixel slack browsers report at rest", () => {
    assert.deepEqual(
      viewportInset({ visualHeight: 799.5, offsetTop: 0, scale: 1.0009, layoutHeight: 800 }),
      { height: null, keyboard: 0 },
    );
  });

  test("never grows past the page when zoomed out", () => {
    assert.deepEqual(
      viewportInset({ visualHeight: 1000, offsetTop: 0, scale: 0.8, layoutHeight: 800 }),
      { height: null, keyboard: 0 },
    );
  });
});
