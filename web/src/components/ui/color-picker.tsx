"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Input } from "@/components/ui/input";
import { type Hsv, hexToHsv, hsvToHex, parseHex } from "@/lib/color";
import { cn } from "@/lib/utils";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * The arrow-key step for a slider: one unit, ten with Shift, Page keys a
 * coarse ten either way. Null for a key that is not a step at all.
 */
function stepFor(event: ReactKeyboardEvent, keys: { up: string[]; down: string[] }) {
  const size = event.shiftKey ? 10 : 1;
  if (keys.up.includes(event.key)) return size;
  if (keys.down.includes(event.key)) return -size;
  return null;
}

/**
 * A pointer drag over `element`, reported as fractions of its box. Pointer
 * capture keeps the drag alive when the hand leaves the box — and the box
 * leaves under it, in a popover near the viewport's edge — the same way in
 * Chromium, Firefox and WebKit, where a native `<input type="color">` would
 * open three different dialogs.
 */
function useDrag(onMove: (x: number, y: number) => void) {
  const report = (event: ReactPointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    onMove(
      clamp((event.clientX - box.left) / (box.width || 1), 0, 1),
      clamp((event.clientY - box.top) / (box.height || 1), 0, 1),
    );
  };
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // Kept from turning into a text selection; focus is given back by hand,
      // since a cancelled press no longer moves it.
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      report(event);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) report(event);
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
  };
}

/**
 * A library-free colour picker: a saturation/brightness square, a hue strip,
 * and the hex it all comes to. Both the square and the strip are ARIA sliders
 * that a pointer drags and the arrow keys step (Shift for ten at a time), and
 * every change is reported as it happens, as lowercase `#rrggbb`.
 *
 * Kept in HSV internally rather than re-derived from `value` each time: a
 * grey or a black has no hue of its own, and dragging the square through one
 * must not snap the hue strip back to red.
 */
export function ColorPicker({
  value,
  onChange,
  label = "Colour",
  className,
}: {
  /** Lowercase `#rrggbb`. */
  value: string;
  onChange: (hex: string) => void;
  /** What the controls are a picker for, prefixed to each one's name. */
  label?: string;
  className?: string;
}) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value) ?? { h: 0, s: 0, v: 0 });
  const [draft, setDraft] = useState(value);
  const hexFocused = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // A value from outside — typed into the hex field, or another device's
  // write — moves the controls, keeping the hue where the colour has none.
  useEffect(() => {
    setHsv((current) => {
      if (hsvToHex(current) === value) return current;
      const next = hexToHsv(value);
      if (!next) return current;
      return next.s === 0 || next.v === 0 ? { ...next, h: current.h } : next;
    });
    if (!hexFocused.current) setDraft(value);
  }, [value]);

  const commit = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    if (!hexFocused.current) setDraft(hex);
    if (hex !== value) onChangeRef.current(hex);
  };

  const square = useDrag((x, y) => commit({ ...hsv, s: x, v: 1 - y }));
  const strip = useDrag((x) => commit({ ...hsv, h: x * 360 }));

  const saturation = Math.round(hsv.s * 100);
  const brightness = Math.round(hsv.v * 100);
  const hue = Math.round(hsv.h);

  return (
    <div className={cn("space-y-2.5", className)}>
      <div
        role="slider"
        tabIndex={0}
        aria-label={`${label} saturation and brightness`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={saturation}
        aria-valuetext={`Saturation ${saturation}%, brightness ${brightness}%`}
        data-color-square
        {...square}
        onKeyDown={(event) => {
          // Sideways is saturation, up and down is brightness: the square's
          // own axes, so the thumb goes where the arrow points.
          const ds = stepFor(event, { up: ["ArrowRight"], down: ["ArrowLeft"] });
          const dv = stepFor(event, { up: ["ArrowUp", "PageUp"], down: ["ArrowDown", "PageDown"] });
          if (ds === null && dv === null) return;
          event.preventDefault();
          event.stopPropagation();
          commit({
            ...hsv,
            s: clamp(hsv.s + (ds ?? 0) / 100, 0, 1),
            v: clamp(hsv.v + (dv ?? 0) / 100, 0, 1),
          });
        }}
        style={{
          backgroundColor: `hsl(${hsv.h} 100% 50%)`,
          backgroundImage:
            "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
        }}
        className="relative h-32 w-full cursor-crosshair touch-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
      >
        <span
          aria-hidden
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            backgroundColor: hsvToHex(hsv),
          }}
          className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
        />
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label={`${label} hue`}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={hue}
        aria-valuetext={`Hue ${hue}°`}
        data-color-hue
        {...strip}
        onKeyDown={(event) => {
          let next: number | null = null;
          if (event.key === "Home") next = 0;
          else if (event.key === "End") next = 360;
          else {
            const step = stepFor(event, {
              up: ["ArrowRight", "ArrowUp", "PageUp"],
              down: ["ArrowLeft", "ArrowDown", "PageDown"],
            });
            if (step !== null) next = clamp(hue + step, 0, 360);
          }
          if (next === null) return;
          event.preventDefault();
          event.stopPropagation();
          commit({ ...hsv, h: next });
        }}
        style={{
          backgroundImage:
            "linear-gradient(to right, #f00, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00)",
        }}
        className="relative h-3 w-full cursor-pointer touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
      >
        <span
          aria-hidden
          style={{ left: `${(hsv.h / 360) * 100}%`, backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
          className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
        />
      </div>
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          style={{ backgroundColor: value }}
          className="size-6 shrink-0 rounded-md border border-border"
        />
        <Input
          aria-label={`${label} hex`}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          maxLength={9}
          onFocus={() => {
            hexFocused.current = true;
          }}
          onBlur={() => {
            hexFocused.current = false;
            // Whatever half-typed value is left gives way to the colour in use.
            setDraft(value);
          }}
          onChange={(event) => {
            const text = event.currentTarget.value;
            setDraft(text);
            const hex = parseHex(text);
            if (hex && hex !== value) onChangeRef.current(hex);
          }}
          className="h-8 font-mono text-xs"
        />
      </div>
    </div>
  );
}
