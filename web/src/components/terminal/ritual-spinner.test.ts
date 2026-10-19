import { describe, expect, test } from "bun:test";
import {
  createRitualSpinner,
  FUTHARK,
  findRitualSpinner,
  paintRitual,
  RITUAL_PHRASES,
  RITUAL_SCAN_MS,
  RITUALS,
  runeFrame,
} from "./ritual-spinner.mjs";

const byId = (id: string) => {
  const ritual = RITUALS.find((r) => r.id === id);
  if (!ritual) throw new Error(`no ritual ${id}`);
  return ritual;
};

describe("the ritual table", () => {
  test("has six rune words and six pictures, six phrases each, none repeated", () => {
    expect(RITUALS.filter((r) => r.word).length).toBe(6);
    expect(RITUALS.filter((r) => !r.word).length).toBe(6);
    for (const ritual of RITUALS) {
      expect(ritual.phrases.length).toBe(6);
    }
    expect(RITUAL_PHRASES.length).toBe(72);
    expect(new Set(RITUAL_PHRASES).size).toBe(72);
  });

  test("every rune word can be spelled, and no letter repeats back to back", () => {
    for (const { word } of RITUALS.filter((r) => r.word)) {
      for (const letter of word ?? "") {
        expect(FUTHARK[letter as keyof typeof FUTHARK]).toBeDefined();
      }
      // A doubled letter shows the same rune twice in a row in one cell, and
      // nobody can see where one ended and the next began.
      expect(word).not.toMatch(/(.)\1/);
    }
  });

  test("every phrase of a rune word names that word", () => {
    for (const { word, phrases } of RITUALS.filter((r) => r.word)) {
      for (const phrase of phrases) {
        expect(phrase.toLowerCase()).toContain((word ?? "").toLowerCase());
      }
    }
  });

  test("phrases are plain words Claude Code can print", () => {
    for (const phrase of RITUAL_PHRASES) {
      expect(phrase).toMatch(/^[A-Z][a-z ]+$/);
    }
  });
});

describe("findRitualSpinner", () => {
  test("finds Claude Code's working line when its word is a ritual phrase", () => {
    const found = findRitualSpinner([
      "> fix the flaky test",
      "",
      "✻ Summoning… (12s · ↓ 1.2k tokens · esc to interrupt)",
      "",
      "  ⏵⏵ bypass permissions on",
    ]);
    expect(found?.row).toBe(2);
    expect(found?.col).toBe(0);
    expect(found?.phrase).toBe("Summoning");
    expect(found?.ritual.id).toBe("triangle");
  });

  test("reads every glyph of the cycle, indentation and the ASCII ellipsis", () => {
    for (const glyph of ["·", "✢", "✳", "✶", "✻", "✽", "*"]) {
      expect(findRitualSpinner([`${glyph} Spawning the horde…`])?.ritual.id).toBe("spawn");
    }
    const indented = findRitualSpinner(["   ✶ Speaking the true name... (3s)"]);
    expect(indented?.col).toBe(3);
    expect(indented?.ritual.id).toBe("triangle");
  });

  test("takes the lowest matching row", () => {
    const found = findRitualSpinner(["✻ Spilling blood…", "✻ Stoking hellfire…"]);
    expect(found?.row).toBe(1);
    expect(found?.ritual.id).toBe("flame");
  });

  test("leaves every other line alone", () => {
    expect(findRitualSpinner([])).toBeNull();
    // Claude Code's own words, the summary it leaves behind, and near misses.
    expect(findRitualSpinner(["✻ Clauding… (4s · esc to interrupt)"])).toBeNull();
    expect(findRitualSpinner(["✻ Worked for 3m 12s"])).toBeNull();
    expect(findRitualSpinner(["✻ Bargaining with the da…"])).toBeNull();
    expect(findRitualSpinner(["✻Summoning…"])).toBeNull();
    expect(findRitualSpinner(["✻ Summoning"])).toBeNull();
    expect(findRitualSpinner(["$ echo Summoning…"])).toBeNull();
    expect(findRitualSpinner(["- Summoning…"])).toBeNull();
  });
});

describe("runeFrame", () => {
  test("spells the word one rune per frame, then holds the last rune flashing", () => {
    const frames = Array.from({ length: 9 }, (_, tick) => runeFrame("SPAWN", tick));
    expect(frames.map((f) => f.rune).join("")).toBe("ᛊᛈᚨᚹᚾᚾᚾᚾᛊ");
    expect(frames.map((f) => f.complete)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      false,
    ]);
  });
});

/** A 2D context that records what was drawn and nothing else. */
function recordingContext() {
  const calls: string[] = [];
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, key) {
      if (key in target) return target[key as string];
      return (...args: unknown[]) => {
        calls.push(`${String(key)}(${args.length})`);
      };
    },
    set(target, key, value) {
      target[key as string] = value;
      return true;
    },
  };
  const ctx = new Proxy({} as Record<string, unknown>, handler);
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("paintRitual", () => {
  test("covers the glyph and then draws every ritual on every frame", () => {
    for (const ritual of RITUALS) {
      for (let tick = 0; tick < 16; tick += 1) {
        const { ctx, calls } = recordingContext();
        paintRitual(ctx, ritual, tick, 32, 32, "#0a0a0a");
        // The first fill is the terminal background over the spinner glyph.
        expect(calls[0]).toBe("setTransform(6)");
        expect(calls[1]).toBe("fillRect(4)");
        // Something is drawn after it.
        expect(calls.length).toBeGreaterThan(2);
      }
    }
  });

  test("a rune word draws its rune as text", () => {
    const { ctx, calls } = recordingContext();
    paintRitual(ctx, byId("omen"), 0, 32, 32, "#0a0a0a");
    expect(calls).toContain("fillText(3)");
  });
});

/** Just enough of an xterm Terminal for the overlay's lifecycle. */
function fakeTerminal(rows: string[]) {
  const markers: { line: number; isDisposed: boolean; dispose(): void }[] = [];
  const decorations: {
    options: Record<string, unknown>;
    disposed: boolean;
    render?: (element: HTMLElement) => void;
  }[] = [];
  const term = {
    rows: rows.length,
    options: { theme: { background: "#0a0a0a" } },
    buffer: {
      active: {
        type: "normal",
        baseY: 100,
        viewportY: 100,
        cursorY: rows.length - 1,
        getLine: (y: number) => ({ translateToString: () => rows[y - 100] ?? "" }),
      },
    },
    registerMarker(offset: number) {
      const marker = {
        line: 100 + (rows.length - 1) + offset,
        isDisposed: false,
        dispose() {
          marker.isDisposed = true;
        },
      };
      markers.push(marker);
      return marker;
    },
    registerDecoration(options: Record<string, unknown>) {
      const decoration: (typeof decorations)[number] = { options, disposed: false };
      decorations.push(decoration);
      return {
        onRender: (render: (element: HTMLElement) => void) => {
          decoration.render = render;
          return { dispose() {} };
        },
        dispose() {
          decoration.disposed = true;
        },
      };
    },
  };
  return { term, rows, markers, decorations };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, RITUAL_SCAN_MS + 30));

describe("createRitualSpinner", () => {
  test("covers the spinner glyph on its line, two cells wide", async () => {
    const fake = fakeTerminal(["$ claude", "", "  ✻ Sealing the pact… (2s)", ""]);
    const spinner = createRitualSpinner(fake.term as never);
    spinner.schedule();
    await settle();
    expect(fake.markers.length).toBe(1);
    expect(fake.markers[0].line).toBe(102);
    expect(fake.decorations[0].options).toMatchObject({
      x: 2,
      width: 2,
      foregroundColor: "#0a0a0a",
    });
    spinner.dispose();
    expect(fake.decorations[0].disposed).toBe(true);
    expect(fake.markers[0].isDisposed).toBe(true);
  });

  test("keeps one overlay while the line stays, and drops it when the turn ends", async () => {
    const fake = fakeTerminal(["✻ Laying the curse…"]);
    const spinner = createRitualSpinner(fake.term as never);
    spinner.schedule();
    await settle();
    fake.rows[0] = "✶ Laying the curse… (1s)";
    spinner.schedule();
    await settle();
    expect(fake.decorations.length).toBe(1);
    fake.rows[0] = "✻ Worked for 2s";
    spinner.schedule();
    await settle();
    expect(fake.decorations[0].disposed).toBe(true);
    spinner.dispose();
  });

  test("works on the alternate screen, where Claude Code draws its interface", async () => {
    // Claude Code v2.1.303's own working line, read back off a real recording.
    const fake = fakeTerminal(["● ", "✢ Possessing… (5s · ↓ 1 tokens)", "  ◐ medium · /effort"]);
    fake.term.buffer.active.type = "alternate";
    const spinner = createRitualSpinner(fake.term as never);
    spinner.schedule();
    await settle();
    expect(fake.decorations.length).toBe(1);
    expect(fake.markers[0].line).toBe(101);
    // Back on the normal screen the same row is a different line: start over.
    fake.term.buffer.active.type = "normal";
    spinner.schedule();
    await settle();
    expect(fake.decorations[0].disposed).toBe(true);
    expect(fake.decorations.length).toBe(2);
    spinner.dispose();
  });

  test("shows itself over xterm's alternate-screen hiding, only while its line is in view", async () => {
    const painted: number[] = [];
    const canvas = {
      width: 0,
      height: 0,
      parentElement: null as unknown,
      style: {} as Record<string, string>,
      setAttribute() {},
      getContext: () => {
        painted.push(canvas.width);
        return recordingContext().ctx;
      },
    };
    const element = {
      clientWidth: 0,
      clientHeight: 0,
      style: { width: "16px", height: "18px", display: "none" },
      replaceChildren(child: typeof canvas) {
        child.parentElement = element;
      },
    };
    const globals = globalThis as { document?: unknown };
    const saved = globals.document;
    globals.document = { createElement: () => canvas };
    try {
      const fake = fakeTerminal(["", "✻ Reciting the litany…"]);
      fake.term.buffer.active.type = "alternate";
      const spinner = createRitualSpinner(fake.term as never);
      spinner.schedule();
      await settle();
      const render = fake.decorations[0].render;
      if (!render) throw new Error("the overlay never asked to be rendered");
      render(element as unknown as HTMLElement);
      expect(element.style.display).toBe("block");
      expect(painted.length).toBeGreaterThan(0);
      // Scrolled out of view, xterm's hidden style stands.
      element.style.display = "none";
      fake.term.buffer.active.viewportY = 102;
      render(element as unknown as HTMLElement);
      expect(element.style.display).toBe("none");
      spinner.dispose();
    } finally {
      globals.document = saved;
    }
  });

  test("does nothing while parked or for other words", async () => {
    const parked = fakeTerminal(["✻ Spilling blood…"]);
    const parkedSpinner = createRitualSpinner(parked.term as never);
    parkedSpinner.setActive(false);
    parkedSpinner.schedule();
    await settle();
    expect(parked.decorations.length).toBe(0);
    parkedSpinner.dispose();

    const plain = fakeTerminal(["✻ Clauding…"]);
    const plainSpinner = createRitualSpinner(plain.term as never);
    plainSpinner.schedule();
    await settle();
    expect(plain.decorations.length).toBe(0);
    plainSpinner.dispose();
  });
});
