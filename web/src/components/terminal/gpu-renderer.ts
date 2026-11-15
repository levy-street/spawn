import type { Terminal as XTerm } from "@xterm/xterm";

/**
 * How many terminals on a page may draw through WebGL at once.
 *
 * The GPU renderer is worth having where someone is typing — the DOM renderer
 * rebuilds rows and forces layout after every echo — but each terminal that
 * has it holds a WebGL context, and Chrome keeps sixteen alive on a page. The
 * seventeenth makes it forcibly lose the oldest, and a terminal whose context
 * was taken that way was left drawing nothing at all: no canvas, and no DOM
 * rows either. One workspace rarely shows that many panes; four side by side
 * easily do (measured 2026-11-15: twenty panes across four columns, fifteen
 * contexts lost, fourteen terminals blank).
 *
 * So the budget stays under that limit with room to spare — a second tab of
 * the app shares the page's process — and the terminals past it render through
 * the DOM, which is slower to echo but always draws (see `restoreDomRenderer`
 * for why "always" needed help).
 */
export const GPU_RENDERER_BUDGET = 12;

/**
 * The page's GPU renderer slots. A terminal asks for one when it comes on
 * screen and gives it back when it parks or goes. A terminal being typed in
 * asks with `focused`, and when the budget is spent it takes the slot of the
 * holder focused longest ago — never worked in at all counts as longest — so
 * the GPU stays with the panes people are working in.
 */
export function createGpuBudget(limit: number = GPU_RENDERER_BUDGET) {
  const holders = new Map<object, { demote: () => void; focusedAt: number }>();
  let clock = 0;
  return {
    /**
     * A slot for `owner`, or false when there is none to be had. `demote` is
     * how the budget takes it back again, for a focused terminal that needs it
     * more: it must drop the owner to the DOM renderer.
     */
    request(owner: object, demote: () => void, focused: boolean): boolean {
      const held = holders.get(owner);
      if (held) {
        if (focused) held.focusedAt = ++clock;
        return true;
      }
      if (holders.size >= limit) {
        if (!focused) return false;
        let oldest: [object, { demote: () => void; focusedAt: number }] | null = null;
        for (const entry of holders) {
          if (!oldest || entry[1].focusedAt < oldest[1].focusedAt) oldest = entry;
        }
        if (!oldest) return false;
        holders.delete(oldest[0]);
        oldest[1].demote();
      }
      holders.set(owner, { demote, focusedAt: focused ? ++clock : 0 });
      return true;
    },

    /** `owner` no longer draws through WebGL. */
    release(owner: object): void {
      holders.delete(owner);
    },

    size(): number {
      return holders.size;
    },
  };
}

/** The page's one budget: every terminal on the page draws from it. */
export const gpuBudget = createGpuBudget();

/** The private corner of xterm's Terminal the hand-back needs. */
interface XTermCore {
  _isDisposed?: boolean;
  _createRenderer?: () => unknown;
  _renderService?: {
    setRenderer(renderer: unknown): void;
    handleResize(cols: number, rows: number): void;
  };
}

/**
 * Put xterm's own DOM renderer back after the WebGL addon has gone.
 *
 * The addon is meant to do this itself on dispose, but the pair we ship does
 * not fit: addon-webgl 0.19 checks `_core._store._isDisposed` first, a field
 * of xterm 6 that xterm 5.5 does not have, so it throws before the renderer is
 * replaced — and the terminal is left with no renderer at all, drawing
 * nothing. Every path that drops a still-living terminal to the DOM went that
 * way: a context the browser took back, and a GPU slot handed to a terminal
 * being typed in. This makes the same two private calls the addon makes,
 * only when no DOM renderer is there, and never on a disposed terminal.
 */
export function restoreDomRenderer(term: XTerm): void {
  if (term.element?.querySelector(".xterm-rows")) return;
  const core = (term as unknown as { _core?: XTermCore })._core;
  if (!core || core._isDisposed || !core._renderService || !core._createRenderer) return;
  core._renderService.setRenderer(core._createRenderer());
  core._renderService.handleResize(term.cols, term.rows);
  term.refresh(0, term.rows - 1);
}
