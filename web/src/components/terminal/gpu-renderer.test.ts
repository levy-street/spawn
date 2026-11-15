import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createGpuBudget, GPU_RENDERER_BUDGET, restoreDomRenderer } from "./gpu-renderer";

/** A terminal asking for the GPU, recording whether it was asked to give it back. */
function terminal() {
  const owner = { demoted: 0 };
  return {
    owner,
    demote: () => {
      owner.demoted += 1;
    },
  };
}

describe("the GPU renderer budget", () => {
  test("stays under the sixteen WebGL contexts Chrome keeps alive on a page", () => {
    // Past sixteen, Chrome forcibly loses the oldest context, and a terminal
    // whose context was lost that way was left drawing nothing at all.
    expect(GPU_RENDERER_BUDGET).toBeLessThan(16);
  });

  test("grants terminals until it is spent, then leaves the rest on the DOM renderer", () => {
    const budget = createGpuBudget(3);
    const [a, b, c, d] = [terminal(), terminal(), terminal(), terminal()];
    expect(budget.request(a.owner, a.demote, false)).toBe(true);
    expect(budget.request(b.owner, b.demote, false)).toBe(true);
    expect(budget.request(c.owner, c.demote, false)).toBe(true);
    expect(budget.request(d.owner, d.demote, false)).toBe(false);
    expect(budget.size()).toBe(3);
    expect([a, b, c].map((t) => t.owner.demoted)).toEqual([0, 0, 0]);
  });

  test("a terminal being typed in takes a slot from the one focused longest ago", () => {
    const budget = createGpuBudget(2);
    const [a, b, c] = [terminal(), terminal(), terminal()];
    budget.request(a.owner, a.demote, false);
    budget.request(b.owner, b.demote, false);
    // a is focused, so b is now the one least recently worked in.
    budget.request(a.owner, a.demote, true);
    expect(budget.request(c.owner, c.demote, true)).toBe(true);
    expect(b.owner.demoted).toBe(1);
    expect(a.owner.demoted).toBe(0);
    expect(budget.size()).toBe(2);
  });

  test("a slot given back is there for the next terminal", () => {
    const budget = createGpuBudget(1);
    const [a, b] = [terminal(), terminal()];
    budget.request(a.owner, a.demote, false);
    expect(budget.request(b.owner, b.demote, false)).toBe(false);
    budget.release(a.owner);
    expect(budget.request(b.owner, b.demote, false)).toBe(true);
  });

  test("once WebGL has failed on the page, nobody asks for it again", () => {
    // A browser with no WebGL at all: every focus used to try again, making a
    // canvas and leaving another dead addon behind each time.
    const budget = createGpuBudget(4);
    const [a, b] = [terminal(), terminal()];
    expect(budget.request(a.owner, a.demote, false)).toBe(true);
    budget.markUnavailable();
    expect(budget.available()).toBe(false);
    expect(budget.size()).toBe(0);
    expect(budget.request(b.owner, b.demote, true)).toBe(false);
    expect(budget.request(a.owner, a.demote, true)).toBe(false);
  });

  test("asking again while holding a slot is not a second slot", () => {
    const budget = createGpuBudget(2);
    const a = terminal();
    budget.request(a.owner, a.demote, false);
    budget.request(a.owner, a.demote, true);
    expect(budget.size()).toBe(1);
  });
});

describe("restoreDomRenderer", () => {
  /** Just enough of an xterm Terminal for the hand-back: an element and its core. */
  function fakeTerminal(options: { rows: boolean; disposed?: boolean }) {
    const calls: string[] = [];
    const term = {
      cols: 80,
      rows: 24,
      element: {
        querySelector: (selector: string) =>
          options.rows && selector === ".xterm-rows" ? {} : null,
      },
      refresh: (start: number, end: number) => calls.push(`refresh ${start}-${end}`),
      _core: {
        _isDisposed: options.disposed ?? false,
        _createRenderer: () => "dom renderer",
        _renderService: {
          setRenderer: (renderer: unknown) => calls.push(`setRenderer ${String(renderer)}`),
          handleResize: (cols: number, rows: number) => calls.push(`handleResize ${cols}x${rows}`),
        },
      },
    };
    return { term, calls };
  }

  test("a terminal the WebGL addon left with no renderer gets the DOM one back", () => {
    // addon-webgl 0.19 hands the terminal back through `_core._store`, which
    // xterm 5.5 does not have: it throws first, and the terminal drew nothing.
    const { term, calls } = fakeTerminal({ rows: false });
    restoreDomRenderer(term as never);
    expect(calls).toEqual(["setRenderer dom renderer", "handleResize 80x24", "refresh 0-23"]);
  });

  test("a terminal already drawing through the DOM is left alone", () => {
    const { term, calls } = fakeTerminal({ rows: true });
    restoreDomRenderer(term as never);
    expect(calls).toEqual([]);
  });

  test("a terminal that has been disposed is left alone", () => {
    const { term, calls } = fakeTerminal({ rows: false, disposed: true });
    restoreDomRenderer(term as never);
    expect(calls).toEqual([]);
  });
});

describe("the xterm pair restoreDomRenderer was written against", () => {
  test("is still the one installed", () => {
    // The hand-back exists because addon-webgl 0.19 expects xterm 6's
    // internals (`_core._store`) and we ship xterm 5.5. An upgrade of either
    // fails here so that someone looks again: the real fix is an addon set
    // that matches the xterm version, at which point the addon restores the
    // DOM renderer itself and this workaround can go.
    const version = (name: string) =>
      JSON.parse(
        readFileSync(
          new URL(`../../../node_modules/${name}/package.json`, import.meta.url),
          "utf8",
        ),
      ).version;
    expect(version("@xterm/xterm")).toBe("5.5.0");
    expect(version("@xterm/addon-webgl")).toBe("0.19.0");
  });
});
