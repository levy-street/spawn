import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

type Listener = (event: FakeTouchEvent) => void;

interface FakeTouchEvent {
  touches: { clientX: number; clientY: number }[];
  timeStamp: number;
  preventDefault: jest.Mock;
  stopPropagation: jest.Mock;
}

interface FakeContainer {
  clientHeight: number;
  addEventListener(type: string, listener: Listener, options?: unknown): void;
  dispatch(type: string, event: FakeTouchEvent): void;
}

interface DispatchedWheel {
  deltaY: number;
  deltaMode: number;
  clientX: number;
  clientY: number;
}

/**
 * The gesture reader is a self-contained function inside the bundled worker.
 * Lifting it out is the only way to exercise the arithmetic without a WebView,
 * an xterm instance and a WebGL context.
 */
function installTouchScrollSource(): string {
  const start = TERMINAL_WORKER_HTML.indexOf("  function installTouchScroll(container) {");
  const end = TERMINAL_WORKER_HTML.indexOf("\n  function watchSurfaceSize(", start);
  if (start < 0 || end < start) throw new Error("installTouchScroll is missing from the worker.");
  return TERMINAL_WORKER_HTML.slice(start, end);
}

interface ScrollHarness {
  container: FakeContainer;
  wheels: DispatchedWheel[];
  sent: string[];
  /** Whether xterm would call preventDefault, i.e. whether it acted on the wheel. */
  consumed: boolean;
}

interface HarnessOptions {
  /** 'vt200' and above carry the wheel; 'none' and 'x10' do not. */
  mouseTrackingMode?: "none" | "x10" | "vt200" | "drag" | "any";
  alternate?: boolean;
}

function harness(options: HarnessOptions = {}): ScrollHarness {
  const wheels: DispatchedWheel[] = [];
  const sent: string[] = [];
  const alternateBuffer = { type: "alternate" };
  const normalBuffer = { type: "normal" };
  const state = {
    term: {
      modes: { mouseTrackingMode: options.mouseTrackingMode ?? "vt200" },
      buffer: {
        active: options.alternate ? alternateBuffer : normalBuffer,
        alternate: alternateBuffer,
      },
      element: {
        dispatchEvent(event: DispatchedWheel) {
          wheels.push(event);
          // dispatchEvent reports false once a listener called preventDefault.
          return !result.consumed;
        },
      },
    },
  };
  const api = {
    sendPty: (bytes: Uint8Array) => {
      sent.push(new TextDecoder().decode(bytes));
      return true;
    },
  };

  const listeners = new Map<string, Listener>();
  const container: FakeContainer = {
    clientHeight: 300,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event);
    },
  };

  const factory = new Function(
    "state",
    "api",
    "encoder",
    "WheelEvent",
    "SCROLL_SLOP_PX",
    "FLING_FRICTION",
    "FLING_MIN_VELOCITY",
    "FLING_MAX_VELOCITY",
    "PAGE_KEY_FRACTION",
    `${installTouchScrollSource()}\nreturn installTouchScroll;`,
  ) as (...args: unknown[]) => (container: FakeContainer) => void;

  const FakeWheelEvent = function (this: DispatchedWheel, _type: string, init: DispatchedWheel) {
    Object.assign(this, init);
  } as unknown as new (
    type: string,
    init: Record<string, unknown>,
  ) => DispatchedWheel;

  factory(state, api, new TextEncoder(), FakeWheelEvent, 6, 0.93, 0.02, 6, 0.5)(container);

  const result: ScrollHarness = { container, wheels, sent, consumed: true };
  return result;
}

function touch(clientY: number, timeStamp: number): FakeTouchEvent {
  return {
    touches: [{ clientX: 40, clientY }],
    timeStamp,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
  };
}

function endTouch(timeStamp: number): FakeTouchEvent {
  return { touches: [], timeStamp, preventDefault: jest.fn(), stopPropagation: jest.fn() };
}

function withFrames(body: (frames: (() => void)[]) => void): void {
  const frames: (() => void)[] = [];
  const raf = jest
    .spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation((callback: FrameRequestCallback) => {
      frames.push(() => callback(0));
      return frames.length;
    });
  try {
    body(frames);
  } finally {
    raf.mockRestore();
  }
}

describe("worker touch scrolling", () => {
  test("ignores travel below the slop so a tap still reaches the terminal", () => {
    const scroll = harness();
    scroll.container.dispatch("touchstart", touch(200, 0));
    const move = touch(196, 16);
    scroll.container.dispatch("touchmove", move);

    expect(scroll.wheels).toEqual([]);
    // Untouched means xterm still sees it, which is what focuses on a tap.
    expect(move.preventDefault).not.toHaveBeenCalled();
    expect(move.stopPropagation).not.toHaveBeenCalled();
  });

  test("replays the drag as a pixel wheel and keeps the touch from xterm", () => {
    const scroll = harness();
    scroll.container.dispatch("touchstart", touch(200, 0));
    const move = touch(170, 16);
    scroll.container.dispatch("touchmove", move);

    expect(move.preventDefault).toHaveBeenCalled();
    expect(move.stopPropagation).toHaveBeenCalled();
    // 30px of travel less the 6px slop, reported in pixels from where the
    // finger is, so a program that cares about the column gets the right one.
    expect(scroll.wheels).toEqual([
      expect.objectContaining({ clientX: 40, clientY: 170, deltaMode: 0, deltaY: 24 }),
    ]);
  });

  test("passes sub-row travel straight through rather than rounding it away", () => {
    const scroll = harness();
    scroll.container.dispatch("touchstart", touch(200, 0));
    scroll.container.dispatch("touchmove", touch(190, 16));
    for (let step = 1; step <= 4; step += 1) {
      scroll.container.dispatch("touchmove", touch(190 - step * 4, 16 + step * 16));
    }

    // xterm accumulates its own partial scroll, so every pixel is handed over.
    expect(scroll.wheels.map((event) => event.deltaY)).toEqual([4, 4, 4, 4, 4]);
  });

  test("dragging down scrolls back toward the live edge", () => {
    const scroll = harness();
    scroll.container.dispatch("touchstart", touch(100, 0));
    scroll.container.dispatch("touchmove", touch(140, 16));

    expect(scroll.wheels.map((event) => event.deltaY)).toEqual([-34]);
  });

  test("a finger held still before lifting places the viewport instead of flinging", () => {
    withFrames((frames) => {
      const scroll = harness();
      scroll.container.dispatch("touchstart", touch(200, 0));
      scroll.container.dispatch("touchmove", touch(140, 16));
      scroll.container.dispatch("touchend", endTouch(400));
      expect(frames).toHaveLength(0);
    });
  });

  test("a flick carries on after release and decays", () => {
    withFrames((frames) => {
      const scroll = harness();
      scroll.container.dispatch("touchstart", touch(300, 0));
      scroll.container.dispatch("touchmove", touch(240, 16));
      scroll.container.dispatch("touchmove", touch(180, 32));
      const release = endTouch(40);
      scroll.container.dispatch("touchend", release);

      expect(release.stopPropagation).toHaveBeenCalled();
      expect(frames).toHaveLength(1);

      scroll.wheels.splice(0);
      frames.shift()?.();
      frames.shift()?.();
      const [first, second] = scroll.wheels.map((event) => event.deltaY);
      expect(first).toBeGreaterThan(0);
      expect(second).toBeGreaterThan(0);
      expect(second).toBeLessThan(first ?? 0);
    });
  });

  test("pages an alternate screen whose program never asked for the wheel", () => {
    const scroll = harness({ alternate: true, mouseTrackingMode: "none" });
    scroll.container.dispatch("touchstart", touch(300, 0));
    // 156px of travel less the 6px slop is exactly one 150px half-screen.
    scroll.container.dispatch("touchmove", touch(144, 16));

    // Never arrow keys: an agent reads those as history in its input box.
    expect(scroll.wheels).toEqual([]);
    expect(scroll.sent).toEqual(["\u001b[6~"]);
  });

  test("leaves the wheel alone for an alternate screen that does report it", () => {
    const scroll = harness({ alternate: true, mouseTrackingMode: "drag" });
    scroll.container.dispatch("touchstart", touch(300, 0));
    scroll.container.dispatch("touchmove", touch(144, 16));

    expect(scroll.sent).toEqual([]);
    expect(scroll.wheels.map((event) => event.deltaY)).toEqual([150]);
  });

  test("stops the fling when nothing consumes the wheel", () => {
    withFrames((frames) => {
      const scroll = harness();
      scroll.container.dispatch("touchstart", touch(300, 0));
      scroll.container.dispatch("touchmove", touch(240, 16));
      scroll.container.dispatch("touchmove", touch(180, 32));
      scroll.container.dispatch("touchend", endTouch(40));

      // The top of the scrollback: xterm leaves the event alone.
      scroll.consumed = false;
      frames.shift()?.();
      expect(frames).toHaveLength(0);
    });
  });
});
