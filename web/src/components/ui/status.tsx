import { agentActivityDetail, agentActivityLabel } from "@/lib/agents";
import type { Agent } from "@/lib/api";
import { cn } from "@/lib/utils";

export type DotTone = "active" | "waiting" | "idle" | "offline";

const TONE_CLASS: Record<DotTone, string> = {
  active: "bg-tone-active",
  waiting: "bg-tone-waiting",
  idle: "bg-tone-idle",
  offline: "bg-tone-offline",
};

export function agentActivityTone(agent: Agent): DotTone {
  switch (agent.activity_state) {
    case "active":
      return "active";
    case "waiting":
    case "input_sent":
    case "starting":
      return "waiting";
    case "quiet":
      return "idle";
    default:
      return agent.status === "running" ? "idle" : "offline";
  }
}

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

export function AgentStatusDot({ agent, className }: { agent: Agent; className?: string }) {
  return (
    <StatusDot
      tone={agentActivityTone(agent)}
      label={agentActivityLabel(agent)}
      title={agentActivityDetail(agent)}
      pulse={agent.activity_state === "active"}
      className={cn("border border-card", className)}
    />
  );
}
