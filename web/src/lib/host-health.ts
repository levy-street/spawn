import type { Host } from "@/lib/api";
import { relativeTime } from "@/lib/sessions";

export type HostHealthCase =
  | "online"
  | "never-connected"
  | "auth-rejected"
  | "stale-version"
  | "plain-offline";

export interface HostHealthPanelState {
  case: HostHealthCase;
  message: string;
  command: "spawnd doctor" | "spawnd login" | "spawnd update" | null;
}

export function hostHealthCase(
  host: Pick<Host, "status" | "last_seen_at" | "last_disconnect" | "update">,
): HostHealthCase {
  if (host.status === "online") return "online";
  if (host.last_seen_at === null) return "never-connected";
  if (host.last_disconnect?.reason === "auth_rejected") return "auth-rejected";
  if (host.update.state === "available" || host.update.state === "failed") {
    return "stale-version";
  }
  return "plain-offline";
}

export function hostHealthPanel(
  host: Pick<Host, "name" | "status" | "last_seen_at" | "last_disconnect" | "version" | "update">,
): HostHealthPanelState {
  const selected = hostHealthCase(host);
  switch (selected) {
    case "online":
      return {
        case: selected,
        message: `${host.name} is online${host.version ? ` · SPAWN D ${host.version}` : ""}.`,
        command: null,
      };
    case "never-connected":
      return {
        case: selected,
        message: "SPAWN D hasn't checked in from this machine yet. On it, run: spawnd doctor",
        command: "spawnd doctor",
      };
    case "auth-rejected":
      return {
        case: selected,
        message: `${host.name} can't sign in. On that machine, run: spawnd login`,
        command: "spawnd login",
      };
    case "stale-version":
      return {
        case: selected,
        message: `${host.name} runs ${host.version ?? "an unknown version"}. On it, run: spawnd update (or it will self-update when idle).`,
        command: "spawnd update",
      };
    case "plain-offline":
      return {
        case: selected,
        message: `Last seen ${relativeTime(host.last_seen_at) ?? "recently"} (connection dropped). If the machine is on, run spawnd doctor there.`,
        command: "spawnd doctor",
      };
  }
}
