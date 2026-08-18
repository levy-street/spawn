import { cn } from "@/lib/utils";

/**
 * The single loading affordance. Inherits `currentColor`; size via the
 * `size` prop (px), color via text utilities on `className`. Replaces every
 * ad-hoc "Loading..." string.
 */
export function Spinner({
  size = 16,
  label = "Loading",
  className,
}: {
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <svg
      className={cn("animate-spin text-muted-foreground", className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label={label}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
