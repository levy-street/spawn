"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { type ComponentType, useEffect, useState } from "react";
import {
  TERMINAL_FONT_OPTIONS,
  TERMINAL_FONT_SIZE_RANGE,
  TERMINAL_LINE_HEIGHT_RANGE,
  TERMINAL_THEME_AUTO,
  TERMINAL_THEMES,
  terminalFontStack,
  terminalTheme,
} from "@/components/terminal/xterm-config.mjs";
import { isFontFamilyAvailable } from "@/lib/font-probe";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  type ThemePreference,
  useTerminalAppearance,
  useTheme,
} from "@/lib/theme";
import { cn } from "@/lib/utils";

const OPTIONS: Array<{
  value: ThemePreference;
  label: string;
  icon: ComponentType<{ className?: string }>;
  hint: string;
}> = [
  { value: "light", label: "Light", icon: Sun, hint: "Always light" },
  { value: "dark", label: "Dark", icon: Moon, hint: "Always dark" },
  { value: "system", label: "System", icon: Monitor, hint: "Match this device" },
];

/**
 * Theme choice. "System" is the default and stays live — changing the OS
 * appearance while spawn is open switches it without a reload.
 */
export function AppearancePanel() {
  const { preference, resolved, setPreference } = useTheme();

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">Appearance</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Applies to this browser. Terminals restyle in place — you do not lose a session by
          switching.
        </p>
      </div>

      <fieldset className="grid grid-cols-3 gap-2">
        <legend className="sr-only">Theme</legend>
        {/* Real radios inside a fieldset: arrow-key navigation, form
            semantics, and screen-reader grouping all come free, and the input
            itself is only hidden visually. */}
        {OPTIONS.map(({ value, label, icon: Icon, hint }) => {
          const selected = preference === value;
          return (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border px-3 py-3 transition-colors",
                "focus-within:ring-2 focus-within:ring-ring",
                selected
                  ? "border-ring bg-accent text-accent-foreground"
                  : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <input
                type="radio"
                name="spawn-theme"
                value={value}
                checked={selected}
                onChange={() => setPreference(value)}
                className="sr-only"
              />
              <Icon className="size-4" aria-hidden />
              <span className="text-sm font-medium">{label}</span>
              <span className="text-[11px] leading-4 text-muted-foreground">{hint}</span>
            </label>
          );
        })}
      </fieldset>

      {preference === "system" && (
        <p className="text-xs text-muted-foreground">This device currently prefers {resolved}.</p>
      )}

      <TerminalAppearanceControls resolved={resolved} />
    </section>
  );
}

/**
 * Terminal palette and typography.
 *
 * Deliberately terminal-only: the app's own accent tokens stay where they
 * are. Recolouring the chrome from here would mean driving `globals.css` and
 * the browser `theme-color` off the same choice, which is a design-system
 * change rather than a terminal preference.
 */
function TerminalAppearanceControls({ resolved }: { resolved: "light" | "dark" }) {
  const { appearance, setAppearance } = useTerminalAppearance();
  // Nothing is downloaded, so only offer a face the viewer's device actually
  // has — otherwise the picker silently selects a font without the glyphs it
  // was chosen for.
  const [installed, setInstalled] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const probe = () => {
      if (cancelled) return;
      const found = new Set<string>();
      for (const option of TERMINAL_FONT_OPTIONS) {
        if (!option.probe) continue;
        try {
          if (isFontFamilyAvailable(option.probe)) found.add(option.id);
        } catch {
          // A context that refuses to measure is one where we simply do not
          // know; leaving the face out is the honest answer.
        }
      }
      setInstalled(found);
    };
    probe();
    // Local faces can resolve slightly after first paint.
    void document.fonts?.ready?.then(probe);
    return () => {
      cancelled = true;
    };
  }, []);

  const fontOptions = TERMINAL_FONT_OPTIONS.filter(
    (option) => !option.probe || installed.has(option.id) || option.id === appearance.fontId,
  );
  const missingCount = TERMINAL_FONT_OPTIONS.length - fontOptions.length;
  const isDefault =
    appearance.themeId === DEFAULT_TERMINAL_APPEARANCE.themeId &&
    appearance.fontId === DEFAULT_TERMINAL_APPEARANCE.fontId &&
    appearance.fontSize === DEFAULT_TERMINAL_APPEARANCE.fontSize &&
    appearance.lineHeight === DEFAULT_TERMINAL_APPEARANCE.lineHeight;

  return (
    <section className="mt-6 flex flex-col gap-4 border-t border-border pt-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Terminal</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Applies to every terminal in this browser, live — you do not lose a session by changing
            it.
          </p>
        </div>
        {!isDefault && (
          <button
            type="button"
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => setAppearance(DEFAULT_TERMINAL_APPEARANCE)}
          >
            Reset
          </button>
        )}
      </div>

      <fieldset className="grid grid-cols-2 gap-2 @sm:grid-cols-3">
        <legend className="sr-only">Terminal theme</legend>
        <ThemeSwatch
          id={TERMINAL_THEME_AUTO}
          label="Match app"
          selected={appearance.themeId === TERMINAL_THEME_AUTO}
          palette={terminalTheme(resolved, TERMINAL_THEME_AUTO)}
          onSelect={() => setAppearance({ themeId: TERMINAL_THEME_AUTO })}
        />
        {TERMINAL_THEMES.map((entry) => (
          <ThemeSwatch
            key={entry.id}
            id={entry.id}
            label={entry.label}
            selected={appearance.themeId === entry.id}
            palette={entry.theme}
            onSelect={() => setAppearance({ themeId: entry.id })}
          />
        ))}
      </fieldset>

      <div className="grid gap-3 @sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Font</span>
          <select
            className="h-9 rounded-md border border-border bg-transparent px-2 text-sm"
            value={appearance.fontId}
            onChange={(e) => setAppearance({ fontId: e.target.value })}
          >
            {fontOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="text-[11px] leading-4 text-muted-foreground">
            {missingCount > 0
              ? `${missingCount} patched font${missingCount === 1 ? "" : "s"} not installed on this device — install one and it appears here.`
              : "Patched Nerd Fonts installed on this device, for powerline and devicon glyphs."}
          </span>
        </label>

        <div className="flex flex-col gap-3">
          <NumberControl
            label="Size"
            value={appearance.fontSize}
            min={TERMINAL_FONT_SIZE_RANGE.min}
            max={TERMINAL_FONT_SIZE_RANGE.max}
            step={1}
            suffix="px"
            onChange={(fontSize) => setAppearance({ fontSize })}
          />
          <NumberControl
            label="Line height"
            value={appearance.lineHeight}
            min={TERMINAL_LINE_HEIGHT_RANGE.min}
            max={TERMINAL_LINE_HEIGHT_RANGE.max}
            step={0.05}
            onChange={(lineHeight) => setAppearance({ lineHeight })}
          />
        </div>
      </div>

      <TerminalSample
        palette={terminalTheme(resolved, appearance.themeId)}
        fontFamily={terminalFontStack(appearance.fontId)}
        fontSize={appearance.fontSize}
        lineHeight={appearance.lineHeight}
      />
    </section>
  );
}

type Palette = Record<string, string | undefined>;

/**
 * Swatch-only stand-in for xterm.js's built-in ANSI palette.
 *
 * `spawn dark` deliberately does not override the 16 colours — it is what
 * ships today, and writing out an explicit palette risks changing the default
 * terminal for everyone over a transcription slip. But a swatch drawn from a
 * theme with no palette would be six identical dots, which reads as a bug.
 *
 * These are used **only to draw the preview**; nothing here reaches a
 * terminal, so an imprecise value costs a slightly-off swatch and nothing
 * else.
 */
const PREVIEW_DEFAULT_ANSI: Palette = {
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
};

function ThemeSwatch({
  id,
  label,
  selected,
  palette,
  onSelect,
}: {
  id: string;
  label: string;
  selected: boolean;
  palette: Palette;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer flex-col gap-1.5 rounded-lg border p-2 transition-colors",
        "focus-within:ring-2 focus-within:ring-ring",
        selected ? "border-ring bg-accent" : "border-border hover:bg-accent/50",
      )}
    >
      <input
        type="radio"
        name="spawn-terminal-theme"
        value={id}
        checked={selected}
        onChange={onSelect}
        className="sr-only"
      />
      <span
        aria-hidden
        className="flex h-9 items-center gap-1 rounded-md px-2"
        style={{ backgroundColor: palette.background ?? "#0a0a0a" }}
      >
        {/* Enough of the palette to tell them apart at a glance — the point
            of a swatch is the colours, not a rendering of the whole theme. */}
        {(["red", "green", "yellow", "blue", "magenta", "cyan"] as const).map((key) => (
          <span
            key={key}
            className="size-2 rounded-full"
            style={{ backgroundColor: palette[key] ?? PREVIEW_DEFAULT_ANSI[key] }}
          />
        ))}
      </span>
      <span className="truncate text-[11px] font-medium">{label}</span>
    </label>
  );
}

function NumberControl({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (next: number) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-sm">
      <span className="w-20 shrink-0 font-medium">{label}</span>
      <input
        type="range"
        className="min-w-0 flex-1 accent-[var(--color-primary)]"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {step < 1 ? value.toFixed(2) : value}
        {suffix}
      </span>
    </label>
  );
}

/**
 * A real sample rather than a colour strip: the thing people are choosing is
 * how their prompt and their agent's output will actually look.
 */
function TerminalSample({
  palette,
  fontFamily,
  fontSize,
  lineHeight,
}: {
  palette: Palette;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}) {
  return (
    <div
      data-testid="terminal-appearance-sample"
      className="overflow-hidden rounded-lg border border-border"
      style={{
        backgroundColor: palette.background ?? "#0a0a0a",
        color: palette.foreground ?? "#e5e5e5",
        fontFamily,
        fontSize: `${fontSize}px`,
        lineHeight,
      }}
    >
      <pre className="overflow-x-auto p-3">
        <span style={{ color: palette.green }}>~/projects/spawn</span>{" "}
        <span style={{ color: palette.blue }}>git:(</span>
        <span style={{ color: palette.red }}>master</span>
        <span style={{ color: palette.blue }}>)</span>{" "}
        <span style={{ color: palette.yellow }}>✗</span>
        {"\n"}
        <span style={{ color: palette.magenta }}>❯</span> cargo test --locked
        {"\n"}
        <span style={{ color: palette.cyan }}>running 12 tests</span>
        {"\n"}
        test result: <span style={{ color: palette.green }}>ok</span>. 12 passed;{" "}
        <span style={{ color: palette.red }}>0 failed</span>
      </pre>
    </div>
  );
}
