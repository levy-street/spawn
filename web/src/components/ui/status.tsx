import { agentActivityDetail, agentActivityLabel } from "@/lib/agents";
import type { Agent } from "@/lib/api";
import { cn } from "@/lib/utils";

export type DotTone = "green" | "sky" | "violet" | "yellow" | "zinc" | "dim" | "red";

const TONE_CLASS: Record<DotTone, string> = {
  green: "bg-emerald-500",
  sky: "bg-sky-400",
  violet: "bg-violet-400",
  yellow: "bg-amber-400",
  zinc: "bg-zinc-400",
  dim: "bg-zinc-600",
  red: "bg-red-500",
};

export function agentActivityTone(agent: Agent): DotTone {
  switch (agent.activity_state) {
    case "active":
      return "green";
    case "waiting":
      return "sky";
    case "input_sent":
      return "violet";
    case "starting":
      return "yellow";
    case "quiet":
      return "zinc";
    default:
      return agent.status === "running" ? "zinc" : "dim";
  }
}

export function hostStatusTone(status: string): DotTone {
  return status === "online" ? "green" : "dim";
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
