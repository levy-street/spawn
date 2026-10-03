import assert from "node:assert/strict";
import { incarnationKey, openIntent } from "./incarnation";

declare function describe(name: string, callback: () => void): void;
declare function test(name: string, callback: () => void | Promise<void>): void;

describe("incarnationKey", () => {
  test("names the window and the host it runs on", () => {
    assert.equal(incarnationKey("s1", "dream"), "s1@dream");
    // Same window, another host: another incarnation.
    assert.notEqual(incarnationKey("s1", "dream"), incarnationKey("s1", "mac"));
  });

  test("has a spelling for a host not known yet", () => {
    assert.equal(incarnationKey("s1", null), "s1@");
  });
});

describe("openIntent", () => {
  test("is held only for the incarnation it was marked for", () => {
    openIntent.mark("w1@mac", 1_000);
    assert.equal(openIntent.has("w1@mac", 1_001), true);
    assert.equal(openIntent.has("w1@dream", 1_001), false);
    openIntent.clear("w1@mac");
    assert.equal(openIntent.has("w1@mac", 1_002), false);
  });

  test("survives being read, so a repeated render sees it too", () => {
    openIntent.mark("w2@mac", 0);
    assert.equal(openIntent.has("w2@mac", 1), true);
    assert.equal(openIntent.has("w2@mac", 2), true);
    openIntent.clear("w2@mac");
  });

  test("lapses when nothing consumed it, so a later move back cannot inherit it", () => {
    openIntent.mark("w3@mac", 0);
    assert.equal(openIntent.has("w3@mac", 60_001), false);
    // Gone, not merely hidden.
    assert.equal(openIntent.has("w3@mac", 0), false);
  });
});
