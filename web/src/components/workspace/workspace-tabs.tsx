"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Ellipsis,
  FolderOpen,
  LayoutTemplate,
  Pencil,
  Plus,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { hostStatusTone, StatusDot } from "@/components/ui/status";
import { toast } from "@/components/ui/toast";
import {
  agents,
  type Host,
  hosts,
  sessions,
  type Workspace,
  workspaces,
  workspaceTemplates,
} from "@/lib/api";
import type { Tile } from "@/lib/grid";
import { GRID_SIZE } from "@/lib/grid";
import { basename } from "@/lib/paths";
import {
  addTab,
  allTiles,
  type LayoutV3,
  MAX_TABS,
  nextTabName,
  removeTab,
  renameTab,
  tabById,
} from "@/lib/tabs";
import { cn } from "@/lib/utils";
import { templateSpecFromWorkspace } from "@/lib/workspace-templates";
import { tabAttentionCount } from "@/lib/workspaces";
import { FolderPickerDialog } from "./folder-picker-dialog";

/**
 * The workspace's tab strip: one button per tab — click to switch, click the
 * active tab again to rename it in place — an always-visible x to close, and
 * a trailing + to add. Every button carries
 * `data-workspace-tab` so the grid's pane drag can hit-test the strip —
 * hovering a tab mid-drag switches to it, dropping on one moves the pane
 * into it (see WorkspaceGrid).
 *
 * Tab CRUD writes the whole v3 envelope through PATCH and updates both query
 * caches optimistically, mirroring the grid's own save path.
 */
export function WorkspaceTabs({
  workspace,
  activeTabId,
  previewTiles,
  focusedId,
  onSwitch,
  onError,
}: {
  workspace: Workspace;
  activeTabId: string;
  /** The grid's in-flight gesture preview; overrides the committed tiles for
   *  the connection measure so the tab restyles while a drag is still on. */
  previewTiles?: Tile[] | null;
  /** The focused session — a connected tab wears the same dim as the pane
   *  beneath it when that pane is not the focused one. */
  focusedId?: string | null;
  onSwitch: (tabId: string) => void;
  onError?: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const stripRef = useRef<HTMLDivElement>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /*
   * Whether the selected tab has canvas content directly beneath it: a tile
   * touching the grid's top row whose column span crosses under the tab (the
   * strip and the canvas share the panel's width, so tab pixels map straight
   * to grid columns). Connected, the tab extends down flush with the panel;
   * over shell ground it rests like the others, corners intact. An empty tab
   * always connects — its whole canvas wears the panel surface.
   */
  const [look, setLook] = useState<{
    connected: boolean;
    dimmed: boolean;
    /** What's directly beneath: the empty tab's panel, or a pane header. */
    surface: "panel" | "header";
  }>({ connected: true, dimmed: false, surface: "panel" });
  const [draft, setDraft] = useState("");
  const [renameWorkspaceOpen, setRenameWorkspaceOpen] = useState(false);
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState("");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [hostPickerOpen, setHostPickerOpen] = useState(false);
  /** A home-host change in flight: picked in the host dialog, committed only
   *  once its folder is chosen — cancelling the folder picker drops it. */
  const [pendingHomeHost, setPendingHomeHost] = useState<Host | null>(null);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateNameDraft, setTemplateNameDraft] = useState("");
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, staleTime: 30_000 });
  const sessionsQ = useQuery({ queryKey: ["sessions"], queryFn: () => sessions.list() });
  const agentsQ = useQuery({ queryKey: ["agents"], queryFn: agents.list, staleTime: 60_000 });
  const hostList = hostsQ.data ?? [];
  const homeHost = hostList.find((host) => host.id === workspace.host_id) ?? null;

  const writeCaches = (next: Workspace) => {
    queryClient.setQueryData(["workspace", next.id], next);
    queryClient.setQueryData<Workspace[]>(["workspaces"], (current) =>
      current?.map((item) => (item.id === next.id ? next : item)),
    );
  };

  const patchM = useMutation({
    mutationFn: (layout: LayoutV3) => workspaces.update(workspace.id, { layout }),
    onMutate: (layout) => {
      onError?.(null);
      writeCaches({ ...workspace, layout });
    },
    onSuccess: writeCaches,
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ["workspace", workspace.id] });
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      onError?.(error instanceof Error ? error.message : String(error));
    },
  });

  useEffect(() => {
    if (renamingId && !workspace.layout.tabs.some((tab) => tab.id === renamingId)) {
      setRenamingId(null);
    }
  }, [renamingId, workspace.layout.tabs]);

  // biome-ignore lint/correctness/useExhaustiveDependencies(renamingId): the rename input swaps a tab for an input, changing every tab's width — re-measure.
  useLayoutEffect(() => {
    const measure = () => {
      const strip = stripRef.current;
      const button = strip?.querySelector(`[data-workspace-tab="${activeTabId}"]`);
      const tiles = previewTiles ?? tabById(workspace.layout, activeTabId)?.layout.tiles ?? [];
      if (!strip || !button || tiles.length === 0) {
        setLook({ connected: true, dimmed: false, surface: "panel" });
        return;
      }
      const stripRect = strip.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      const from = ((rect.left - stripRect.left) / stripRect.width) * GRID_SIZE;
      const to = ((rect.right - stripRect.left) / stripRect.width) * GRID_SIZE;
      // Fully connected or not at all: the top row must cover the tab's whole
      // span — sweep the merged y=0 intervals across it (half-cell slack for
      // pixel rounding).
      const spans = tiles
        .filter((tile) => tile.y === 0)
        .map((tile) => [tile.x, tile.x + tile.w] as const)
        .sort((a, b) => a[0] - b[0]);
      let reach = from + 0.05;
      for (const [start, end] of spans) {
        if (start > reach) break;
        reach = Math.max(reach, end);
      }
      // Matching dim: when every pane under the tab is unfocused (so washed),
      // the connected tab wears the same wash — one sheet, one shade.
      const underTab = tiles.filter(
        (tile) => tile.y === 0 && tile.x < to - 0.05 && from + 0.05 < tile.x + tile.w,
      );
      setLook({
        connected: reach >= to - 0.05,
        dimmed: tiles.length > 1 && !underTab.some((tile) => tile.session_id === focusedId),
        surface: "header",
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [activeTabId, focusedId, previewTiles, renamingId, workspace.layout]);

  const add = () => {
    const next = addTab(workspace.layout, crypto.randomUUID(), nextTabName(workspace.layout));
    if (!next) return;
    patchM.mutate(next);
    onSwitch(next.active_tab as string);
  };

  const close = async (tabId: string) => {
    const tab = workspace.layout.tabs.find((item) => item.id === tabId);
    const next = removeTab(workspace.layout, tabId);
    if (!tab || !next) return;
    const sessionIds = tab.layout.tiles
      .filter((tile) => !tile.widget)
      .map((tile) => tile.session_id);
    if (sessionIds.length > 0) {
      const accepted = await confirm({
        title: `Close ${tab.name}?`,
        body: `${sessionIds.length === 1 ? "Its session" : `Its ${sessionIds.length} sessions`} will be closed and the running ${sessionIds.length === 1 ? "process" : "processes"} killed.`,
        confirmLabel: "Close tab",
        destructive: true,
      });
      if (!accepted) return;
      const results = await Promise.allSettled(sessionIds.map((id) => sessions.remove(id)));
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) {
        onError?.(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
        return;
      }
    }
    patchM.mutate(next);
    if (tabId === activeTabId) onSwitch(next.active_tab as string);
  };

  const settingsM = useMutation({
    mutationFn: (body: { name?: string; cwd?: string; host_id?: string }) =>
      workspaces.update(workspace.id, body),
    onSuccess: (saved) => {
      writeCaches(saved);
      onError?.(null);
    },
    onError: (error) => onError?.(error instanceof Error ? error.message : String(error)),
  });

  const saveTemplateM = useMutation({
    mutationFn: (name: string) =>
      workspaceTemplates.create({
        name,
        // The workspace home rides along: creating from the template goes
        // straight to this folder, no picker.
        ...(workspace.host_id && workspace.cwd
          ? { host_id: workspace.host_id, cwd: workspace.cwd }
          : {}),
        spec: templateSpecFromWorkspace(
          workspace.layout,
          new Map((sessionsQ.data ?? []).map((session) => [session.id, session])),
          agentsQ.data ?? [],
        ),
      }),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["workspace-templates"] });
      toast(`Saved "${saved.name}" as a template.`);
    },
    onError: (error) => onError?.(error instanceof Error ? error.message : String(error)),
  });

  const submitSaveTemplate = (event?: FormEvent) => {
    event?.preventDefault();
    const name = templateNameDraft.trim();
    setSaveTemplateOpen(false);
    if (name) saveTemplateM.mutate(name.slice(0, 128));
  };

  const deleteWorkspace = async () => {
    const sessionCount = allTiles(workspace.layout).filter((tile) => !tile.widget).length;
    const accepted = await confirm({
      title: `Delete ${workspace.name}?`,
      body:
        sessionCount > 0
          ? `Every session in this workspace (${sessionCount}) will be closed and its process killed.`
          : "The workspace and its tabs will be removed.",
      confirmLabel: "Delete workspace",
      destructive: true,
    });
    if (!accepted) return;
    try {
      await workspaces.remove(workspace.id);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
    router.replace("/");
  };

  const submitWorkspaceRename = (event?: FormEvent) => {
    event?.preventDefault();
    const name = workspaceNameDraft.trim();
    setRenameWorkspaceOpen(false);
    if (name && name !== workspace.name) settingsM.mutate({ name: name.slice(0, 128) });
  };

  const submitRename = (tabId: string, event?: FormEvent) => {
    event?.preventDefault();
    const name = draft.trim();
    const tab = workspace.layout.tabs.find((item) => item.id === tabId);
    setRenamingId(null);
    if (!tab || !name || name === tab.name) return;
    patchM.mutate(renameTab(workspace.layout, tabId, name.slice(0, 64)));
  };

  const canClose = workspace.layout.tabs.length > 1;
  const sessionsById = useMemo(
    () => new Map((sessionsQ.data ?? []).map((session) => [session.id, session])),
    [sessionsQ.data],
  );

  return (
    /*
     * Shaped like real tabs: the strip is a band of the shell ground with a
     * sliver of ground beneath the resting tabs; the selected tab alone
     * extends down through it — a few px more room at its bottom — staying
     * flush with the content so tab and panel read as one connected sheet.
     * The first tab sits flush with the panel's left edge.
     */
    <div
      ref={stripRef}
      role="tablist"
      aria-label="Workspace tabs"
      className="flex h-11 shrink-0 items-end gap-1.5 overflow-x-auto bg-shell pr-1.5 pb-1.5"
    >
      {workspace.layout.tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const attention = tabAttentionCount(tab, sessionsById);
        if (renamingId === tab.id) {
          return (
            // The strip has no left padding, so the first tab's input would
            // lose its border and focus ring to the panel edge.
            <form
              key={tab.id}
              onSubmit={(event) => submitRename(tab.id, event)}
              className="pb-0.5 pl-0.5"
            >
              <Input
                autoFocus
                aria-label={`Rename ${tab.name}`}
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
                onBlur={() => submitRename(tab.id)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setRenamingId(null);
                  }
                }}
                className="h-7 w-32 px-2 text-xs"
              />
            </form>
          );
        }
        return (
          <div key={tab.id} className="relative shrink-0">
            <button
              type="button"
              role="tab"
              aria-selected={active}
              data-workspace-tab={tab.id}
              onClick={() => {
                if (active) {
                  setDraft(tab.name);
                  setRenamingId(tab.id);
                } else {
                  onSwitch(tab.id);
                }
              }}
              className={cn(
                "flex h-8 min-w-40 items-center gap-1.5 rounded-md pl-3 text-xs font-medium transition-colors",
                canClose ? "pr-6.5" : "pr-3.5",
                // The label stays level with the resting tabs: the extra
                // height is all bottom padding, swallowed by flex centering.
                // A connected tab continues the surface directly beneath it:
                // a pane's header tint (card over background), washed exactly
                // like the pane when that pane is unfocused; the empty tab's
                // plain panel otherwise.
                active && "bg-[var(--tab-surface)] text-foreground",
                active &&
                  (look.connected && look.surface === "header"
                    ? look.dimmed
                      ? "[--tab-surface:color-mix(in_oklab,var(--foreground)_3.5%,color-mix(in_oklab,var(--card)_75%,var(--background)))] dark:[--tab-surface:color-mix(in_oklab,black_25%,color-mix(in_oklab,var(--card)_75%,var(--background)))]"
                      : "[--tab-surface:color-mix(in_oklab,var(--card)_75%,var(--background))]"
                    : "[--tab-surface:var(--background)]"),
                // `tab-connected` flares the foot into the panel: see globals.
                active && look.connected && "tab-connected -mb-1.5 h-[38px] rounded-b-none pb-1.5",
                !active &&
                  "bg-background/40 text-muted-foreground hover:bg-background/60 hover:text-foreground",
                // The badge is its own visual edge, so it sits closer in than
                // a bare label wants to.
                attention > 0 && "pl-2",
              )}
            >
              {/* What is waiting behind this tab, the same rollup the sidebar
                  puts on a workspace row — read before the name. */}
              {attention > 0 && (
                <Badge variant="warning" className="shrink-0 px-1.5 py-0 text-[10px] leading-4">
                  {attention}
                </Badge>
              )}
              <span className="max-w-48 truncate">{tab.name}</span>
            </button>
            {canClose && (
              <button
                type="button"
                aria-label={`Close ${tab.name}`}
                onClick={() => void close(tab.id)}
                className={cn(
                  "absolute right-1.5 top-4 grid size-4.5 -translate-y-1/2 place-items-center rounded-sm transition-colors",
                  "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <X className="size-3" aria-hidden />
              </button>
            )}
          </div>
        );
      })}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="New tab"
        disabled={workspace.layout.tabs.length >= MAX_TABS || patchM.isPending}
        onClick={add}
        className="mb-0.5 size-7 shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-3.5" aria-hidden />
      </Button>

      {/* Core workspace settings live at the strip's far right; adding panes
          is the floating launcher's job (bottom-right of the viewport). */}
      <DropdownMenu
        align="end"
        className="mb-0.5 ml-auto shrink-0"
        renderTrigger={(props) => (
          <Button
            {...props}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${workspace.name} settings`}
            className="size-7 text-muted-foreground hover:text-foreground"
          >
            <Ellipsis className="size-4" aria-hidden />
          </Button>
        )}
      >
        <DropdownMenuItem
          onSelect={() => {
            setWorkspaceNameDraft(workspace.name);
            setRenameWorkspaceOpen(true);
          }}
        >
          <Pencil className="size-4" aria-hidden />
          Rename workspace
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={hostList.length === 0 || (hostList.length === 1 && Boolean(homeHost))}
          onSelect={() => setHostPickerOpen(true)}
        >
          <Server className="size-4" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {homeHost ? `Host: ${homeHost.name}` : "Set host…"}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!homeHost} onSelect={() => setFolderPickerOpen(true)}>
          <FolderOpen className="size-4" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {workspace.cwd ? `Folder: ${basename(workspace.cwd) || workspace.cwd}` : "Set folder…"}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            setTemplateNameDraft(workspace.name);
            setSaveTemplateOpen(true);
          }}
        >
          <LayoutTemplate className="size-4" aria-hidden />
          Save as template
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={() => void deleteWorkspace()}>
          <Trash2 className="size-4" aria-hidden />
          Delete workspace
        </DropdownMenuItem>
      </DropdownMenu>

      <Dialog open={renameWorkspaceOpen} onOpenChange={setRenameWorkspaceOpen}>
        <DialogContent size="sm">
          <form onSubmit={submitWorkspaceRename}>
            <DialogHeader>
              <DialogTitle>Rename workspace</DialogTitle>
            </DialogHeader>
            <div className="px-6 py-2">
              <Input
                autoFocus
                aria-label="Workspace name"
                value={workspaceNameDraft}
                onChange={(event) => setWorkspaceNameDraft(event.currentTarget.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setRenameWorkspaceOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!workspaceNameDraft.trim()}>
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={saveTemplateOpen} onOpenChange={setSaveTemplateOpen}>
        <DialogContent size="sm">
          <form onSubmit={submitSaveTemplate}>
            <DialogHeader>
              <DialogTitle>Save as template</DialogTitle>
            </DialogHeader>
            <div className="space-y-2 px-6 py-2">
              <Input
                autoFocus
                aria-label="Template name"
                value={templateNameDraft}
                onChange={(event) => setTemplateNameDraft(event.currentTarget.value)}
              />
              <p className="text-xs text-muted-foreground">
                Saves this workspace's tabs, pane arrangement, and what runs in each pane. New
                workspaces created from it pick their own folder.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setSaveTemplateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!templateNameDraft.trim()}>
                Save template
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={hostPickerOpen} onOpenChange={setHostPickerOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Choose this workspace's host</DialogTitle>
          </DialogHeader>
          <div className="space-y-1 px-6 py-2">
            <p className="pb-1 text-xs text-muted-foreground">
              New panes open on this host. Existing panes stay where they are.
            </p>
            {hostList.map((host) => {
              const current = host.id === workspace.host_id;
              return (
                <button
                  key={host.id}
                  type="button"
                  disabled={host.status !== "online"}
                  onClick={() => {
                    setHostPickerOpen(false);
                    if (current) return;
                    // The change lands with its folder: the picker that
                    // follows browses the new host, and committing both at
                    // once means cancelling it changes nothing.
                    setPendingHomeHost(host);
                    setFolderPickerOpen(true);
                  }}
                  className="flex h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                >
                  <StatusDot tone={hostStatusTone(host.status)} label={host.status} />
                  <span className="min-w-0 flex-1 truncate">{host.name}</span>
                  {host.status !== "online" && (
                    <span className="shrink-0 text-xs text-muted-foreground">offline</span>
                  )}
                  {current && (
                    <Check className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                </button>
              );
            })}
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setHostPickerOpen(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FolderPickerDialog
        key={`${(pendingHomeHost ?? homeHost)?.id ?? "none"}:${folderPickerOpen ? "open" : "closed"}`}
        open={folderPickerOpen}
        host={pendingHomeHost ?? homeHost}
        onOpenChange={(open) => {
          setFolderPickerOpen(open);
          if (!open) setPendingHomeHost(null);
        }}
        onSelect={(path) =>
          settingsM.mutate(
            pendingHomeHost ? { host_id: pendingHomeHost.id, cwd: path } : { cwd: path },
          )
        }
      />
    </div>
  );
}
