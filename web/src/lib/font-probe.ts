/**
 * Whether a font family is actually installed on this device.
 *
 * `document.fonts.check()` is the obvious API and the wrong one: it answers
 * "can the document render text in this list", and a *locally installed*
 * family that the page never declared is reported as available whether or not
 * it exists — so it returns true for every Nerd Font on a machine with none
 * of them. Verified in headless Chromium before writing this.
 *
 * The reliable test is metric comparison: render a string in
 * `"<candidate>", <fallback>` and in `<fallback>` alone. If the candidate is
 * missing, the browser falls back and the two widths are identical. Three
 * structurally different fallbacks are tried, because a candidate could
 * coincidentally match one of them.
 */

const PROBE_TEXT = "MMMMMMMMMMlliii1234567890@#%&";
const PROBE_SIZE_PX = 72;
const FALLBACKS = ["monospace", "serif", "sans-serif"] as const;

let context: CanvasRenderingContext2D | null | undefined;

function probeContext(): CanvasRenderingContext2D | null {
  if (context !== undefined) return context;
  try {
    context = document.createElement("canvas").getContext("2d");
  } catch {
    context = null;
  }
  return context;
}

/** Reset the cached measuring context. Tests replace the canvas plumbing. */
export function resetFontProbe(): void {
  context = undefined;
}

export function isFontFamilyAvailable(family: string): boolean {
  const ctx = probeContext();
  if (!ctx) return false;
  const measure = (fontFamily: string): number => {
    ctx.font = `${PROBE_SIZE_PX}px ${fontFamily}`;
    return ctx.measureText(PROBE_TEXT).width;
  };
  for (const fallback of FALLBACKS) {
    const baseline = measure(fallback);
    // A zero-width baseline means the canvas is not measuring at all (some
    // headless and privacy-hardened contexts); claiming the font exists off
    // that would be a guess.
    if (!baseline) return false;
    if (measure(`"${family}", ${fallback}`) !== baseline) return true;
  }
  return false;
}
