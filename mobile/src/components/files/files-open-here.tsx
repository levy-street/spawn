import { type OpenHereRequest, OpenHereSheet } from "@/components/launcher/open-here-sheet";
import { useToast } from "@/components/ui/toast";
import { useFileHost } from "@/data/queries/files";
import { useHostSessionsQuery } from "@/data/queries/hosts";

/** A window opened from a folder, for whatever shows the file browser to go to. */
export interface OpenedWindow {
  workspaceId: string;
  sessionId: string;
}

export interface FilesOpenHereProps {
  hostId: string;
  /** The folder and what to run there; null hides the sheet. */
  request: OpenHereRequest | null;
  onDismiss(): void;
  onOpened(opened: OpenedWindow): void;
}

/**
 * "Open terminal here" and "Start agent here…" from a folder in the file
 * browser: the host page's own "New window here…" sheet with the folder
 * already chosen, so the window is made through the one window maker
 * (`launcher/create-window.ts`) and lands in a workspace the same way. Mounted
 * only once someone asks, so a folder screen reads no workspaces or windows
 * until then. Where the new window is shown is the caller's to say: the body
 * never navigates itself.
 */
export function FilesOpenHere({ hostId, request, onDismiss, onOpened }: FilesOpenHereProps) {
  const toast = useToast();
  const host = useFileHost(hostId);
  const sessions = useHostSessionsQuery(hostId);
  if (!host.data) return null;
  return (
    <OpenHereSheet
      host={host.data}
      onDismiss={onDismiss}
      onOpened={({ workspaceId, sessionId, warning }) => {
        if (warning) toast.error("Agent not queued", { detail: warning });
        onOpened({ workspaceId, sessionId });
      }}
      request={request}
      sessions={sessions.data ?? []}
    />
  );
}
