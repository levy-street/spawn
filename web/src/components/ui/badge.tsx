import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const VARIANTS = {
  default: "border-border bg-secondary/60 text-secondary-foreground",
  outline: "border-border bg-transparent text-muted-foreground",
  success: "border-success/25 bg-success-soft text-success",
  warning: "border-warning/25 bg-warning-soft text-warning",
  info: "border-info/25 bg-info-soft text-info",
  destructive: "border-destructive/25 bg-destructive-soft text-destructive",
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
