"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { type Workspace, workspaces } from "@/lib/api";
import { relativeTime } from "@/lib/sessions";

/**
 * The one thing that marks an archived workspace on its own page.
 *
 * There is nothing else to change: archiving stops the windows, it does not
 * take them apart, so the canvas below is the real one — same tabs, same
 * tiles, same windows, each showing that it exited. This says why they are
 * all stopped and offers the single act that starts them again.
 */
export function ArchivedBanner({ workspace }: { workspace: Workspace }) {
  const queryClient = useQueryClient();
  const restoreM = useMutation({
    mutationFn: () => workspaces.unarchive(workspace.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      queryClient.invalidateQueries({ queryKey: ["workspace"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const when = relativeTime(workspace.archived_at);

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/20 px-3 py-2">
      <Archive className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
        <span className="text-foreground">Archived{when ? ` ${when}` : ""}.</span> Every window in
        here is stopped and nothing is running on the host — restore it to pick up where you left
        off.
      </p>
      <Button
        type="button"
        size="sm"
        disabled={restoreM.isPending}
        onClick={() => restoreM.mutate()}
        className="shrink-0"
      >
        <RotateCcw className="size-3.5" aria-hidden />
        Restore
      </Button>
    </div>
  );
}
