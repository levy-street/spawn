/**
 * Opt-in keystroke-latency HUD (`localStorage.spawnLatencyHud = "on"`).
 *
 * Headless probes measure a synthetic environment; the latency a user FEELS
 * happens in their browser, on their display, next to their other tabs. This
 * instrument runs there: every printable keystroke is timed from input to
 * first echo bytes and to the paint after them, a one-line overlay shows the
 * rolling distribution, and every spike above the threshold is kept with its
 * timestamp so "it hitched a minute ago" can be checked against data.
 *
 * Zero overhead when disabled (one flag check at wiring time), and the
 * enabled path does no layout reads on the keystroke path — the overlay text
 * updates at most once a second.
 */

const WINDOW_MS = 60_000;
const SPIKE_THRESHOLD_MS = 100;
const MAX_PENDING = 32;
const MAX_SPIKES = 50;

type Sample = { at: number; echo: number; paint: number | null };
type Spike = { wall: string; echo: number; paint: number | null };

export function latencyHudEnabled(): boolean {
  try {
    return window.localStorage.getItem("spawnLatencyHud") === "on";
  } catch {
    return false;
  }
}

export class LatencyHud {
  #pending: number[] = [];
  #samples: Sample[] = [];
  #spikes: Spike[] = [];
  #element: HTMLDivElement | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  attach(host: HTMLElement): void {
    if (this.#element) return;
    const el = document.createElement("div");
    el.dataset.testid = "terminal-latency-hud";
    el.style.cssText =
      "position:absolute;right:8px;bottom:8px;z-index:20;pointer-events:none;" +
      "font:11px/1.4 monospace;color:#9ae6b4;background:rgba(0,0,0,0.65);" +
      "padding:3px 8px;border-radius:4px;white-space:pre";
    el.textContent = "latency hud: waiting for keystrokes";
    host.appendChild(el);
    this.#element = el;
    this.#timer = setInterval(() => this.#render(), 1_000);
  }

  detach(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#element?.remove();
    this.#element = null;
  }

  /** Call when the user produced one printable keystroke of input. */
  noteKeystroke(now: number): void {
    this.#pending.push(now);
    if (this.#pending.length > MAX_PENDING) this.#pending.shift();
  }

  /** Call when PTY bytes arrive; returns a token to close out paint time. */
  noteEcho(now: number): ((paintAt: number) => void) | null {
    // Age out keystrokes the app never echoed (app busy, control input).
    while (this.#pending.length > 0 && now - this.#pending[0] > 2_000) {
      this.#pending.shift();
    }
    const key = this.#pending.shift();
    if (key === undefined) return null;
    const sample: Sample = { at: now, echo: now - key, paint: null };
    this.#samples.push(sample);
    if (sample.echo > SPIKE_THRESHOLD_MS) {
      this.#spikes.push({
        wall: new Date().toISOString().slice(11, 19),
        echo: Math.round(sample.echo),
        paint: null,
      });
      if (this.#spikes.length > MAX_SPIKES) this.#spikes.shift();
    }
    const cutoff = now - WINDOW_MS;
    while (this.#samples.length > 0 && this.#samples[0].at < cutoff) {
      this.#samples.shift();
    }
    return (paintAt: number) => {
      sample.paint = paintAt - (sample.at - sample.echo);
      const spike = this.#spikes[this.#spikes.length - 1];
      if (spike && spike.echo === Math.round(sample.echo) && spike.paint === null) {
        spike.paint = Math.round(sample.paint);
      }
    };
  }

  get spikeLog(): readonly Spike[] {
    return this.#spikes;
  }

  #render(): void {
    const el = this.#element;
    if (!el) return;
    const echoes = this.#samples.map((s) => s.echo).sort((a, b) => a - b);
    if (echoes.length === 0) return;
    const pick = (q: number) => echoes[Math.min(echoes.length - 1, Math.floor(q * echoes.length))];
    const last = this.#spikes[this.#spikes.length - 1];
    el.textContent =
      `echo p50 ${pick(0.5).toFixed(0)}ms  p90 ${pick(0.9).toFixed(0)}ms  ` +
      `max ${echoes[echoes.length - 1].toFixed(0)}ms  (${echoes.length} keys/60s)\n` +
      `spikes>${SPIKE_THRESHOLD_MS}ms: ${this.#spikes.length}` +
      (last
        ? `  last ${last.echo}ms @${last.wall}${last.paint ? ` paint ${last.paint}ms` : ""}`
        : "");
    el.style.color =
      last && this.#samples.some((s) => s.echo > SPIKE_THRESHOLD_MS) ? "#fbb" : "#9ae6b4";
  }
}
