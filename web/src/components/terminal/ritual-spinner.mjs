/**
 * The ritual spinner: a small animation SPAWN D draws over Claude Code's
 * spinner glyph when the word beside it is one of the ritual phrases below.
 *
 * Claude Code's working line reads `✻ Summoning… (12s · esc to interrupt)`.
 * Claude Code picks the word at random from the person's `spinnerVerbs`
 * setting and redraws the glyph several times a second. When that word is one
 * of the 72 phrases here, the client covers the glyph and the space after it
 * with a two-cell canvas and plays the animation that belongs to the phrase,
 * so the picture always matches the words. Any other word, including every
 * one of Claude Code's defaults, leaves the line untouched: the feature is
 * switched on by putting these phrases in Claude Code's settings and off by
 * taking them out (docs/RITUAL_SPINNER.md).
 *
 * Like the agent notice, this is a read of the rendered screen in the client
 * that shows it. The daemon and the server stay content-blind (docs/TRUST.md).
 *
 * Single source of truth for BOTH frontends:
 *   - web imports it (web/src/components/terminal/Terminal.tsx), and
 *   - mobile's terminal worker inlines it at build time
 *     (mobile/src/terminal/worker/build-worker.mjs), which strips the
 *     `export` keywords and publishes the exports as `SpawnRitualSpinner`.
 * So it stays plain browser JavaScript with no imports.
 */

/** How long one animation frame lasts, close to Claude Code's own spinner. */
export const RITUAL_FRAME_MS = 120;

/** How long after output settles the screen is read for the spinner line. */
export const RITUAL_SCAN_MS = 150;

/** The frame a picture holds under reduced motion: every traced line drawn. */
const STILL_PICTURE_TICK = 10;

/**
 * The glyphs Claude Code cycles through, plus the `*` some terminals get in
 * place of `✳`. Only the first non-space cell of a row is ever compared.
 */
export const CLAUDE_SPINNER_GLYPHS = "·✢✳✶✻✽*";

/**
 * Twelve rituals, six phrases each. Half spell their word in runes, so every
 * one of their phrases carries that word; the other half are pictures, and
 * their phrases describe what the picture shows. No phrase appears twice.
 *
 * @typedef {"spawn" | "daemon" | "pact" | "curse" | "omen" | "sigil"
 *   | "blood" | "pentagram" | "flame" | "triangle" | "eyes" | "rune-circle"} RitualId
 * @typedef {{ id: RitualId, word?: string, phrases: readonly string[] }} Ritual
 * @type {readonly Ritual[]}
 */
export const RITUALS = Object.freeze([
  {
    id: "spawn",
    word: "SPAWN",
    phrases: [
      "Spawning",
      "Spawning the horde",
      "Calling forth the spawn",
      "Hatching the spawn",
      "Raising the spawn",
      "Unleashing the spawn",
    ],
  },
  {
    id: "daemon",
    word: "DAEMON",
    phrases: [
      "Invoking the daemon",
      "Waking the daemon",
      "Binding the daemon",
      "Feeding the daemon",
      "Bargaining with the daemon",
      "Whispering to the daemon",
    ],
  },
  {
    id: "pact",
    word: "PACT",
    phrases: [
      "Sealing the pact",
      "Forging the pact",
      "Striking a pact",
      "Honoring the pact",
      "Reading the pact",
      "Binding the pact",
    ],
  },
  {
    id: "curse",
    word: "CURSE",
    phrases: [
      "Laying the curse",
      "Weaving the curse",
      "Speaking the curse",
      "Deepening the curse",
      "Inscribing the curse",
      "Lifting the curse",
    ],
  },
  {
    id: "omen",
    word: "OMEN",
    phrases: [
      "Reading the omens",
      "Heeding the omen",
      "Seeking an omen",
      "Divining the omen",
      "Decoding the omen",
      "Awaiting an omen",
    ],
  },
  {
    id: "sigil",
    word: "SIGIL",
    phrases: [
      "Carving the sigil",
      "Tracing the sigil",
      "Charging the sigil",
      "Etching the sigil",
      "Burning the sigil",
      "Awakening the sigil",
    ],
  },
  {
    id: "blood",
    phrases: [
      "Signing in blood",
      "Spilling blood",
      "Offering blood",
      "Drawing blood",
      "Paying the blood price",
      "Sealing it in blood",
    ],
  },
  {
    id: "pentagram",
    phrases: [
      "Drawing the pentagram",
      "Tracing the star",
      "Closing the circle",
      "Inscribing the pentacle",
      "Chalking the star",
      "Completing the pentagram",
    ],
  },
  {
    id: "flame",
    phrases: [
      "Stoking hellfire",
      "Kindling the flames",
      "Feeding the fire",
      "Fanning the flames",
      "Lighting the pyre",
      "Burning bright",
    ],
  },
  {
    id: "triangle",
    phrases: [
      "Summoning",
      "Binding the spirit",
      "Calling up the dead",
      "Commanding the spirit",
      "Speaking the true name",
      "Beckoning from beyond",
    ],
  },
  {
    id: "eyes",
    phrases: [
      "Possessing",
      "Staring into the void",
      "Watching from the dark",
      "Taking hold",
      "Opening the eyes",
      "Gazing back",
    ],
  },
  {
    id: "rune-circle",
    phrases: [
      "Chanting the incantation",
      "Reciting the litany",
      "Speaking in tongues",
      "Intoning the dark rite",
      "Murmuring forbidden words",
      "Awakening the runes",
    ],
  },
]);

/** Every phrase, in table order: the list a person puts in `spinnerVerbs`. */
export const RITUAL_PHRASES = Object.freeze(RITUALS.flatMap((ritual) => ritual.phrases));

const RITUAL_BY_PHRASE = new Map(
  RITUALS.flatMap((ritual) => ritual.phrases.map((phrase) => [phrase, ritual])),
);

/**
 * Elder Futhark, one rune per Latin letter. C and K share the K rune, as they
 * did; the table only needs the letters the rune words use.
 */
export const FUTHARK = Object.freeze({
  A: "ᚨ",
  B: "ᛒ",
  C: "ᚲ",
  D: "ᛞ",
  E: "ᛖ",
  F: "ᚠ",
  G: "ᚷ",
  H: "ᚺ",
  I: "ᛁ",
  K: "ᚲ",
  L: "ᛚ",
  M: "ᛗ",
  N: "ᚾ",
  O: "ᛟ",
  P: "ᛈ",
  R: "ᚱ",
  S: "ᛊ",
  T: "ᛏ",
  U: "ᚢ",
  W: "ᚹ",
});

/** Frames a rune word holds its last rune for, flashing, before it starts over. */
const RUNE_HOLD_FRAMES = 3;

/**
 * Which rune of `word` shows on frame `tick`, and whether the word is complete
 * and flashing. One rune per frame, then a short hold on the last one.
 *
 * @param {string} word
 * @param {number} tick
 * @returns {{ rune: string, index: number, complete: boolean }}
 */
export function runeFrame(word, tick) {
  const cycle = word.length + RUNE_HOLD_FRAMES;
  const step = ((tick % cycle) + cycle) % cycle;
  const index = Math.min(step, word.length - 1);
  return { rune: FUTHARK[word[index]] ?? "", index, complete: step >= word.length };
}

/**
 * The spinner line on screen, if its word is a ritual phrase. `rows` is the
 * text of the live screen's rows, top to bottom. The search starts from the
 * bottom, where Claude Code keeps its working line.
 *
 * @param {readonly string[]} rows
 * @returns {{ row: number, col: number, ritual: Ritual, phrase: string } | null}
 */
export function findRitualSpinner(rows) {
  for (let row = rows.length - 1; row >= 0; row -= 1) {
    const match = parseSpinnerRow(rows[row]);
    if (match) return { row, ...match };
  }
  return null;
}

/**
 * @param {string} text
 * @returns {{ col: number, ritual: Ritual, phrase: string } | null}
 */
function parseSpinnerRow(text) {
  let col = 0;
  while (col < text.length && text[col] === " ") col += 1;
  if (col >= text.length || !CLAUDE_SPINNER_GLYPHS.includes(text[col])) return null;
  if (text[col + 1] !== " ") return null;
  const rest = text.slice(col + 2);
  const end = rest.search(/…|\.\.\./);
  if (end <= 0) return null;
  const phrase = rest.slice(0, end);
  const ritual = RITUAL_BY_PHRASE.get(phrase);
  return ritual ? { col, ritual, phrase } : null;
}

const BLOOD = "#e11e15";
const EMBER = "#ff6e3c";
const GOLD = "#ffc44d";
const ASH = "#5a0a06";
const WHITE_HOT = "#fff1b0";

/** @param {number} n @param {number} r @param {number} offset */
function polygon(n, r, offset) {
  const points = [];
  for (let k = 0; k < n; k += 1) {
    const a = -Math.PI / 2 + offset + (k * 2 * Math.PI) / n;
    points.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return points;
}

/** @param {CanvasRenderingContext2D} c @param {string} color @param {number} width @param {number} [r] */
function ring(c, color, width, r = 28) {
  c.strokeStyle = color;
  c.lineWidth = width;
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
  c.stroke();
}

/**
 * Trace a polygon one side per frame after the circle appears, then flash.
 * @param {CanvasRenderingContext2D} c @param {number} t
 * @param {readonly number[]} order vertex visiting order, closed
 * @param {readonly (readonly number[])[]} vertices
 */
function traced(c, t, order, vertices) {
  const n = t % 14;
  ring(c, n >= 1 ? BLOOD : ASH, 3);
  c.strokeStyle = n >= 11 ? (n % 2 ? GOLD : EMBER) : BLOOD;
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(vertices[order[0]][0], vertices[order[0]][1]);
  const sides = Math.min(order.length - 1, Math.max(0, n - 1));
  for (let k = 1; k <= sides; k += 1) c.lineTo(vertices[order[k]][0], vertices[order[k]][1]);
  c.stroke();
  return n;
}

/** Pixel flame frames: a 6 by 8 grid of heat levels, 0 for empty. */
const FLAME_FRAMES = [
  "000000000000001000001000012100012100123210123310",
  "000000000100000100001210001210012310123421123321",
  "000000001000001100012100012210123210124321123321",
  "000100000100001200001210012310013420123421123321",
];
const FLAME_HEAT = ["", BLOOD, EMBER, GOLD, WHITE_HOT];
const RING_RUNES = "ᚠᚢᚦᚨᚱᚲ";

/**
 * The picture rituals, each drawn in a 64 by 64 box centred on the origin.
 * @type {Record<string, (c: CanvasRenderingContext2D, t: number) => void>}
 */
const PICTURES = {
  blood(c, t) {
    const n = t % 12;
    c.fillStyle = ASH;
    c.beginPath();
    c.ellipse(0, 25, 14 + (n >= 10 ? 6 : 0), 4, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = BLOOD;
    if (n >= 10) {
      for (const x of [-14, 14]) {
        c.beginPath();
        c.arc(x, 18 - (n - 9) * 3, 3, 0, Math.PI * 2);
        c.fill();
      }
      return;
    }
    const r = Math.min(6, 2 + n * 1.5);
    const y = n >= 4 ? -24 + (n - 3) * 7 : -24;
    c.beginPath();
    c.arc(0, y, r, 0, Math.PI * 2);
    c.moveTo(-r, y);
    c.lineTo(0, y - r * 2.2);
    c.lineTo(r, y);
    c.fill();
    c.fillStyle = EMBER;
    c.fillRect(-2, y - 2, 2, 2);
  },
  pentagram(c, t) {
    traced(c, t, [0, 2, 4, 1, 3, 0], polygon(5, 26, 0));
  },
  flame(c, t) {
    const frame = FLAME_FRAMES[t % FLAME_FRAMES.length];
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 6; x += 1) {
        const heat = Number(frame[y * 6 + x]);
        if (!heat) continue;
        c.fillStyle = FLAME_HEAT[heat];
        c.fillRect(-24 + x * 8, -32 + y * 8, 8, 8);
      }
    }
  },
  triangle(c, t) {
    const n = traced(c, t, [0, 1, 2, 0], polygon(3, 24, 0));
    if (n >= 6) ring(c, n >= 11 ? GOLD : EMBER, 2, 10);
    if (n >= 8) {
      c.fillStyle = n % 2 ? GOLD : BLOOD;
      c.beginPath();
      c.arc(0, 0, 3, 0, Math.PI * 2);
      c.fill();
    }
  },
  eyes(c, t) {
    const n = t % 10;
    const open = n !== 0 && n !== 5;
    c.fillStyle = BLOOD;
    c.beginPath();
    c.moveTo(-20, -6);
    c.lineTo(-27, -30);
    c.lineTo(-10, -14);
    c.moveTo(20, -6);
    c.lineTo(27, -30);
    c.lineTo(10, -14);
    c.fill();
    c.fillStyle = ASH;
    c.beginPath();
    c.arc(0, 4, 22, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = BLOOD;
    c.lineWidth = 2;
    c.stroke();
    for (const x of [-9, 9]) {
      c.fillStyle = open ? (t % 2 ? GOLD : EMBER) : ASH;
      c.beginPath();
      c.ellipse(x, 0, 5, open ? 3 : 1, x < 0 ? 0.35 : -0.35, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = open ? BLOOD : ASH;
    c.fillRect(-7, 13, 14, 2);
  },
  "rune-circle"(c, t) {
    ring(c, BLOOD, 3);
    ring(c, ASH, 2, 15);
    c.font = "12px sans-serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    polygon(6, 22, t * 0.26).forEach(([x, y], k) => {
      c.fillStyle = k === t % 6 ? GOLD : EMBER;
      c.fillText(RING_RUNES[k], x, y);
    });
    const pulse = t % 4 < 2;
    c.fillStyle = pulse ? BLOOD : EMBER;
    c.beginPath();
    c.arc(0, 0, pulse ? 4 : 6, 0, Math.PI * 2);
    c.fill();
  },
};

/**
 * Paint one frame of `ritual` into a `width` by `height` canvas context whose
 * pixels are already scaled for the device. The background is filled first so
 * the spinner glyph underneath never shows through.
 *
 * @param {CanvasRenderingContext2D} c
 * @param {Ritual} ritual
 * @param {number} tick
 * @param {number} width
 * @param {number} height
 * @param {string} background
 */
export function paintRitual(c, ritual, tick, width, height, background) {
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = background;
  c.fillRect(0, 0, width, height);
  if (ritual.word) {
    const { rune, complete } = runeFrame(ritual.word, tick);
    c.fillStyle = complete ? (tick % 2 ? GOLD : EMBER) : GOLD;
    c.font = `${Math.round(height * 0.8)}px ui-monospace, "Noto Sans Runic", sans-serif`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(rune, width / 2, height / 2);
    return;
  }
  const size = Math.min(width, height);
  c.setTransform(size / 64, 0, 0, size / 64, width / 2, height / 2);
  PICTURES[ritual.id]?.(c, tick);
}

/**
 * Watch a terminal for a ritual spinner line and keep an animated canvas over
 * its glyph while it lasts.
 *
 * `schedule()` is called after every write the terminal finishes; it reads the
 * screen a beat later, never per byte. The overlay is an xterm decoration two
 * cells wide (the glyph and the space after it), its foreground set to the
 * terminal background so the glyph is gone even before the canvas paints.
 * `setActive(false)` drops the overlay and stops the timer, for terminals that
 * are parked or hidden. With reduced motion the ritual shows one still frame.
 *
 * @param {import("@xterm/xterm").Terminal} term
 * @returns {{ schedule(): void, setActive(active: boolean): void, dispose(): void }}
 */
export function createRitualSpinner(term) {
  /** @type {null | { line: number, col: number, ritual: Ritual, background: string, screen: string,
   *   decoration: import("@xterm/xterm").IDecoration, marker: import("@xterm/xterm").IMarker,
   *   canvas: HTMLCanvasElement | null }} */
  let current = null;
  let active = true;
  let disposed = false;
  let tick = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let scanTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let frameTimer = null;

  const reducedMotion = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const terminalBackground = () => {
    const background = term.options.theme?.background;
    return typeof background === "string" && /^#[0-9a-f]{6}$/i.test(background)
      ? background
      : "#000000";
  };

  function stopFrames() {
    if (frameTimer !== null) clearInterval(frameTimer);
    frameTimer = null;
  }

  function clear() {
    stopFrames();
    if (!current) return;
    current.decoration.dispose();
    current.marker.dispose();
    current = null;
  }

  function paint() {
    const canvas = current?.canvas;
    if (!current || !canvas) return;
    const c = canvas.getContext("2d");
    if (!c) return;
    paintRitual(c, current.ritual, tick, canvas.width, canvas.height, current.background);
  }

  /** @param {HTMLElement} element */
  function mount(element) {
    if (!current) return;
    const row = current.marker.line - term.buffer.active.viewportY;
    if (row < 0 || row >= term.rows) return;
    // xterm 5 hides every decoration while the alternate screen is up, and
    // Claude Code draws its whole interface there. It sets that style just
    // before handing the element over, so the ritual shows itself again here;
    // off screen (above) the hidden style stands.
    element.style.display = "block";
    const width = element.clientWidth || Number.parseFloat(element.style.width) || 0;
    const height = element.clientHeight || Number.parseFloat(element.style.height) || 0;
    if (!width || !height) return;
    let canvas = current.canvas;
    if (!canvas || canvas.parentElement !== element) {
      canvas = document.createElement("canvas");
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.cssText = "display:block;width:100%;height:100%;pointer-events:none";
      element.replaceChildren(canvas);
      current.canvas = canvas;
    }
    const scale = globalThis.devicePixelRatio || 1;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    paint();
  }

  function scan() {
    scanTimer = null;
    if (disposed || !active) return clear();
    // Either screen: Claude Code draws its whole interface on the alternate
    // screen, unlike the agent notice's status bar. The match is a spinner
    // glyph, a space and an exact ritual phrase, which no other program prints.
    const buffer = term.buffer.active;
    const rows = [];
    for (let y = buffer.baseY; y < buffer.baseY + term.rows; y += 1) {
      rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
    }
    const found = findRitualSpinner(rows);
    if (!found) return clear();
    const line = buffer.baseY + found.row;
    const background = terminalBackground();
    if (
      current &&
      !current.marker.isDisposed &&
      current.marker.line === line &&
      current.col === found.col &&
      current.ritual === found.ritual &&
      current.background === background &&
      current.screen === buffer.type
    ) {
      return;
    }
    clear();
    const marker = term.registerMarker(line - (buffer.baseY + buffer.cursorY));
    if (!marker) return;
    const decoration = term.registerDecoration({
      marker,
      x: found.col,
      width: 2,
      foregroundColor: background,
      layer: "top",
    });
    if (!decoration) {
      marker.dispose();
      return;
    }
    current = {
      line,
      col: found.col,
      ritual: found.ritual,
      background,
      decoration,
      marker,
      canvas: null,
      screen: buffer.type,
    };
    // A new ritual starts from its first frame: a traced pentagram begins with
    // its circle, a rune word with its first letter. Held still, a picture
    // shows its finished frame instead of an empty circle.
    const still = reducedMotion();
    tick = still && !found.ritual.word ? STILL_PICTURE_TICK : 0;
    decoration.onRender(mount);
    if (!still) {
      frameTimer = setInterval(() => {
        tick += 1;
        paint();
      }, RITUAL_FRAME_MS);
    }
  }

  return {
    schedule() {
      if (disposed || !active || scanTimer !== null) return;
      scanTimer = setTimeout(scan, RITUAL_SCAN_MS);
    },
    setActive(next) {
      active = next;
      if (!active) clear();
    },
    dispose() {
      disposed = true;
      if (scanTimer !== null) clearTimeout(scanTimer);
      scanTimer = null;
      clear();
    },
  };
}
