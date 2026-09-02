"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import type { ComponentType } from "react";
import { type ThemePreference, useTheme } from "@/lib/theme";
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
    </section>
  );
}

/**
 * The same choice as a row of a menu — the account menu carries it so the
 * theme is one press away from anywhere, without a trip through Settings.
 *
 * A track the width of the menu, three equal segments of glyphs and no
 * heading: sun, moon and screen already are the words, so each keeps its
 * name for the accessibility tree and as a hover title and shows nothing
 * else. Choosing
 * one keeps the menu open — the change lands on the whole window as the
 * segment moves, which is the readout a person wants, and a menu that
 * vanished the instant it was pressed would take the chance to change their
 * mind away with it.
 */
export function ThemeMenuRow() {
  const { preference, setPreference } = useTheme();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the click is only stopped here so the segments below keep the menu open; the interactive elements are the radios themselves.
    <div onClick={(event) => event.stopPropagation()}>
      <div className="m-1 grid grid-cols-3 gap-0.5 rounded-md bg-popover-accent/50 p-0.5">
        {OPTIONS.map(({ value, label, icon: Icon }) => {
          const selected = preference === value;
          return (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              aria-label={label}
              title={label}
              onClick={() => setPreference(value)}
              className={cn(
                "grid h-8 place-items-center rounded-[5px] outline-none transition-colors",
                "focus-visible:ring-1 focus-visible:ring-ring",
                selected
                  ? "bg-popover-accent text-popover-foreground shadow-sm"
                  : "text-muted-foreground hover:text-popover-foreground",
              )}
            >
              <Icon className="size-4" aria-hidden />
            </button>
          );
        })}
      </div>
    </div>
  );
}
