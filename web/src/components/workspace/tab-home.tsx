"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Folder } from "lucide-react";
import { type JSX, type ReactNode, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { hostStatusTone, StatusDot } from "@/components/ui/status";
import { type Host, hosts as hostsApi, type Workspace, workspaces } from "@/lib/api";
import { basename } from "@/lib/paths";
import { type LayoutV3, tabById, tabHome, withTabHome } from "@/lib/tabs";
import { cn } from "@/lib/utils";
import { FolderPickerDialog } from "./folder-picker-dialog";

/**
 * A tab's home — the host and folder its windows open in — as a thing you can
 * change. Null on the tab means it inherits the workspace's home, so the
 * control shows where windows would actually land either way and only writes
 * the tab's own pair once the user picks one.
 *
 * Picking is host-then-folder, and with a single host the host step is skipped
 * entirely: the folder browser is the whole flow.
 */
export function useTabHome(
  workspace: Workspace,
  tabId: string,
  onError?: (message: string | null) => void,
): {
  /** Where windows added to this tab open, resolved through the fallback. */
  home: { host: Host | null; cwd: string } | null;
  /** True when the tab carries its own pair rather than inheriting. */
  owned: boolean;
  /** Start picking: the host list, or the folder browser when there is one host. */
  open: () => void;
  /** Mount once next to whatever triggers `open`. */
  dialogs: ReactNode;
} {
  const queryClient = useQueryClient();
  const [hostPickerOpen, setHostPickerOpen] = useState(false);
  const [pickerHost, setPickerHost] = useState<Host | null>(null);
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hostsApi.list, staleTime: 15_000 });
  const hostList = hostsQ.data ?? [];
  const resolved = tabHome(workspace.layout, tabId, workspace);
  const host = hostList.find((item) => item.id === resolved?.host_id) ?? null;
  const tab = tabById(workspace.layout, tabId);

  const saveM = useMutation({
    mutationFn: (layout: LayoutV3) => workspaces.update(workspace.id, { layout }),
    onSuccess: (saved) => {
      onError?.(null);
      queryClient.setQueryData(["workspace", workspace.id], saved);
      queryClient.setQueryData<Workspace[]>(["workspaces"], (current) =>
        current?.map((item) => (item.id === saved.id ? saved : item)),
      );
    },
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ["workspace", workspace.id] });
      onError?.(error instanceof Error ? error.message : String(error));
    },
  });

  const start = () => {
    const only = hostList.length === 1 ? hostList[0] : null;
    if (only) {
      setPickerHost(only);
      return;
    }
    setHostPickerOpen(true);
  };

  const dialogs = (
    <>
      <Dialog open={hostPickerOpen} onOpenChange={setHostPickerOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Choose this tab's host</DialogTitle>
          </DialogHeader>
          <div className="space-y-1 px-6 py-2">
            <p className="pb-1 text-xs text-muted-foreground">
              New windows in this tab open here. Windows already on the canvas stay where they are.
            </p>
            {hostList.map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={item.status !== "online"}
                onClick={() => {
                  setHostPickerOpen(false);
                  setPickerHost(item);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm",
                  "hover:bg-accent disabled:pointer-events-none disabled:opacity-50",
                )}
              >
                <StatusDot tone={hostStatusTone(item.status)} label={item.status} />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                {item.id === host?.id && (
                  <span className="shrink-0 text-xs text-muted-foreground">current</span>
                )}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <FolderPickerDialog
        key={`${pickerHost?.id ?? "none"}:${pickerHost ? "open" : "closed"}`}
        open={pickerHost !== null}
        host={pickerHost}
        onOpenChange={(next) => {
          if (!next) setPickerHost(null);
        }}
        onSelect={(path) => {
          if (!pickerHost) return;
          saveM.mutate(withTabHome(workspace.layout, tabId, { host_id: pickerHost.id, cwd: path }));
          setPickerHost(null);
        }}
      />
    </>
  );

  return {
    home: resolved ? { host, cwd: resolved.cwd } : null,
    owned: Boolean(tab?.host_id && tab?.cwd),
    open: start,
    dialogs,
  };
}

/**
 * The tab's home as a chip: the folder it opens windows in, clickable to move
 * it. Shown where there is nothing else to say where things land — the empty
 * tab's own canvas.
 */
export function TabHomeButton({
  workspace,
  tabId,
  className,
  onError,
}: {
  workspace: Workspace;
  tabId: string;
  className?: string;
  onError?: (message: string | null) => void;
}): JSX.Element {
  const { home, open, dialogs } = useTabHome(workspace, tabId, onError);
  const hostName = home?.host?.name;
  return (
    <>
      <button
        type="button"
        onClick={open}
        title={home ? `${home.cwd}${hostName ? ` on ${hostName}` : ""}` : undefined}
        className={cn(
          "inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1.5",
          "text-sm text-muted-foreground transition-colors hover:border-ring/50 hover:bg-accent hover:text-foreground",
          className,
        )}
      >
        <Folder className="size-4 shrink-0" aria-hidden />
        <span className="truncate">
          {home ? basename(home.cwd) || home.cwd : "Choose this tab's folder"}
        </span>
        {hostName && (
          <span className="shrink-0 text-xs text-muted-foreground/70">on {hostName}</span>
        )}
        <ChevronDown className="size-3.5 shrink-0 opacity-50" aria-hidden />
      </button>
      {dialogs}
    </>
  );
}
