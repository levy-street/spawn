import assert from "node:assert/strict";
import { uploadRatio } from "./upload-progress";

declare function describe(name: string, callback: () => void): void;
declare function test(name: string, callback: () => void | Promise<void>): void;

describe("uploadRatio", () => {
  test("is null when nothing is in flight", () => {
    assert.equal(uploadRatio([]), null);
  });

  test("reports one upload's byte progress", () => {
    assert.equal(uploadRatio([{ sent: 250, total: 1000 }]), 0.25);
  });

  test("weights concurrent uploads by size", () => {
    // The small file finishing must not drag the bar most of the way up.
    const ratio = uploadRatio([
      { sent: 40_000, total: 40_000 },
      { sent: 0, total: 20_000_000 },
    ]);
    assert.ok(ratio !== null && ratio < 0.01);
  });

  test("shows an empty bar for a zero-byte upload rather than dividing by zero", () => {
    assert.equal(uploadRatio([{ sent: 0, total: 0 }]), 0);
  });

  test("never exceeds full, even if a chunk callback overshoots", () => {
    assert.equal(uploadRatio([{ sent: 2000, total: 1000 }]), 1);
  });
});
