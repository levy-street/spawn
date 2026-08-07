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
