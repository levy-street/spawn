import type { Session } from "@/lib/api";
import { sessionActivityDetail, sessionActivityLabel, sessionActivityTone } from "@/lib/sessions";
import { cn } from "@/lib/utils";

/** Maps 1:1 to the `--tone-*` design tokens (see docs/DESIGN.md). */
export type DotTone = "active" | "waiting" | "idle" | "offline";

const TONE_CLASS: Record<DotTone, string> = {
  active: "bg-tone-active",
  waiting: "bg-tone-waiting",
  idle: "bg-tone-idle",
  offline: "bg-tone-offline",
};

export function hostStatusTone(status: string): DotTone {
  return status === "online" ? "active" : "offline";
}

export function StatusDot({
  tone,
  label,
  title,
  pulse = false,
  className,
}: {
  tone: DotTone;
  label?: string;
  title?: string;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative inline-flex size-2 shrink-0 rounded-full",
        TONE_CLASS[tone],
        className,
      )}
      role="img"
      aria-label={label}
      title={title ?? label}
    >
      {pulse && (
        <span
          aria-hidden
          className={cn("absolute inset-0 animate-ping rounded-full opacity-60", TONE_CLASS[tone])}
        />
      )}
    </span>
  );
}

export function SessionStatusDot({ session, className }: { session: Session; className?: string }) {
  return (
    <StatusDot
      tone={sessionActivityTone(session)}
      label={sessionActivityLabel(session)}
      title={sessionActivityDetail(session)}
      pulse={session.activity_state === "active"}
      className={cn("border border-card", className)}
    />
  );
}
