"use client";

import { Monitor, Moon, ScrollText, Sun } from "lucide-react";
import { type ComponentType, useState } from "react";
import { setUnifiedScrollbackEnabled, unifiedScrollbackEnabled } from "@/lib/scrollback-mode";
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

      <UnifiedScrollbackToggle />
    </section>
  );
}

/**
 * Experiment: scroll through committed history inside the live terminal
 * itself (one buffer, like a desktop terminal) instead of the snapshot
 * overlay. Applying it reloads the app — terminals are kept warm across
 * navigation, and a mid-session flip would leave pool instances straddling
 * both behaviours.
 */
function UnifiedScrollbackToggle() {
  const [enabled] = useState(() => unifiedScrollbackEnabled());

  const toggle = () => {
    setUnifiedScrollbackEnabled(!enabled);
    window.location.reload();
  };

  return (
    <div className="mt-2 border-t border-border pt-4">
      <h3 className="text-sm font-semibold">Experiments</h3>
      <label className="mt-2 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={toggle}
          className="mt-0.5 size-4 accent-foreground"
        />
        <span>
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <ScrollText className="size-4" aria-hidden />
            Unified scrollback
          </span>
          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
            Scroll through history inside the terminal itself, like a desktop terminal, instead of
            the snapshot overlay. Changing this reloads the app; terminal sessions are unaffected.
          </span>
        </span>
      </label>
    </div>
  );
}
