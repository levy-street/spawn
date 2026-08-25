import { Badge } from "@/components/ui/badge";
import { Chip } from "@/components/ui/chip";
import type { HostOut } from "@/data/api/schemas/hosts";

export type VisibleHostUpdateState = "available" | "updating";
const promptedHostDetails = new Set<string>();

export function visibleHostUpdateState(host: HostOut): VisibleHostUpdateState | null {
  const state = host.update?.state;
  return state === "available" || state === "updating" ? state : null;
}

export function hostUpdateLabel(host: HostOut): "update available" | "updating" | null {
  const state = visibleHostUpdateState(host);
  if (state === "available") return "update available";
  return state === "updating" ? "updating" : null;
}

export function hostNeedsUpdatePrompt(host: HostOut): boolean {
  const state = host.update?.state;
  return (
    state === "available" || state === "updating" || state === "failed" || state === "unsupported"
  );
}

export function claimHostDetailUpdatePrompt(host: HostOut): boolean {
  if (!hostNeedsUpdatePrompt(host) || promptedHostDetails.has(host.id)) return false;
  promptedHostDetails.add(host.id);
  return true;
}

export function HostUpdateBadge({ host }: { host: HostOut }): React.JSX.Element | null {
  const label = hostUpdateLabel(host);
  if (!label) return null;
  return <Badge variant={host.update?.state === "available" ? "warning" : "info"}>{label}</Badge>;
}

export function HostUpdateChip({ host }: { host: HostOut }): React.JSX.Element | null {
  const label = hostUpdateLabel(host);
  if (!label) return null;
  return <Chip variant={host.update?.state === "available" ? "warning" : "info"}>{label}</Chip>;
}
