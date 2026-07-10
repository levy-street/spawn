import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const VARIANTS = {
  default: "border-border bg-secondary/60 text-secondary-foreground",
  outline: "border-border bg-transparent text-muted-foreground",
  success: "border-emerald-500/25 bg-emerald-500/10 text-emerald-400",
  warning: "border-amber-500/25 bg-amber-500/10 text-amber-400",
  info: "border-sky-500/25 bg-sky-500/10 text-sky-400",
  destructive: "border-destructive/25 bg-destructive/10 text-destructive",
} as const;

export type BadgeVariant = keyof typeof VARIANTS;

export function Badge({
  variant = "default",
  className,
  children,
}: {
  variant?: BadgeVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4",
        VARIANTS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
