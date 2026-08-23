"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A binary on/off control for a setting that applies immediately.
 *
 * `role="switch"` rather than a checkbox: a checkbox says "this will be true
 * when you submit", and nothing here is submitted. Built on a real `<button>`
 * so Space and Enter, focus rings, and disabled semantics all come from the
 * platform rather than from handlers.
 *
 * Use `SwitchRow` for the common case — a labelled setting with a line of
 * explanation — so the hit area covers the whole row rather than the 36px
 * track, which matters on a phone.
 */

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, className, disabled, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-primary bg-primary" : "border-border bg-muted",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow-sm transition-transform",
          // Motion here is decorative only; the aria-checked state is what
          // anything non-visual reads (DESIGN.md rule 6).
          checked ? "translate-x-[1.125rem]" : "translate-x-0.5",
        )}
      />
    </button>
  ),
);
Switch.displayName = "Switch";

export interface SwitchRowProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  /** One line under the label. Where a channel is unavailable, say why here
   *  rather than leaving a dead toggle to be poked at. */
  hint?: React.ReactNode;
  disabled?: boolean;
  icon?: React.ReactNode;
  className?: string;
}

function SwitchRow({
  checked,
  onCheckedChange,
  label,
  hint,
  disabled,
  icon,
  className,
}: SwitchRowProps) {
  const id = React.useId();
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border border-border p-3 transition-colors",
        disabled ? "opacity-60" : "hover:bg-accent/40",
        className,
      )}
    >
      {icon ? (
        <span className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden>
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <label
          htmlFor={id}
          className={cn("block text-sm font-medium", !disabled && "cursor-pointer")}
        >
          {label}
        </label>
        {hint ? <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
        className="mt-0.5"
      />
    </div>
  );
}

export { Switch, SwitchRow };
