"use client";

import { Slot } from "@radix-ui/react-slot";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, LayoutGrid, Plus, SquareTerminal } from "lucide-react";
import { useRouter } from "next/navigation";
import { forwardRef, type ReactElement, useId, useImperativeHandle, useRef, useState } from "react";
import { AgentIcon } from "@/components/icons/AgentIcon";
import { HostUpdateDialog, useHostUpdate } from "@/components/release/HostUpdateDialog";
import {
  type CascadeItem,
  CascadeMenu,
  type CascadeMenuHandle,
  type CascadePanel,
} from "@/components/ui/cascade-menu";
import { toast } from "@/components/ui/toast";
import {
  createWindow,
  type WindowWorkspace,
  workspaceHasRoom,
} from "@/components/workspace/create-window";
import { isWorkspaceFullError } from "@/components/workspace/new-session-menu-helpers";
import { useWherePanel } from "@/components/workspace/where-picker";
import { type Agent, agents, type Host, type Workspace, workspaces } from "@/lib/api";
import { OPEN_TERMINAL_HERE_LABEL, START_AGENT_HERE_LABEL } from "@/lib/files/copy";
import { displayPath } from "@/lib/places";
import { cn } from "@/lib/utils";
import { isArchived } from "@/lib/workspaces";

/** What the window runs. */
type Choice = { kind: "shell" } | { kind: "agent"; agent: Agent };

function choiceKey(choice: Choice): string {
  return choice.kind === "agent" ? `agent-${choice.agent.id}` : "shell";
}

const LAST_WORKSPACE_KEY = "spawn.workspaces.last";

function lastWorkspaceId(): string | null {
  try {
    return window.localStorage.getItem(LAST_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

/**
 * The workspaces a window from a host's page can open in: the one used last
 * first, then the rest in the sidebar's order. Archived ones are put away and
 * are not offered.
 */
function workspaceChoices(list: readonly Workspace[], last: string | null): Workspace[] {
  const open = list.filter((workspace) => !isArchived(workspace));
  const ordered = [...open].sort((left, right) => left.position - right.position);
  const lastUsed = ordered.find((workspace) => workspace.id === last);
  return lastUsed ? [lastUsed, ...ordered.filter((item) => item !== lastUsed)] : ordered;
}

/**
 * What opening a window "here" takes, once a host is known: the agents to
 * offer, the "Open in which workspace?" step, and the open itself — through
 * the same `createWindow` every other "+" uses, then this tab goes to it.
 * Shared by the host page's menus and the file browser's.
 */
export function useOpenHere(host: Host | null) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const hostUpdate = useHostUpdate(null);
  const agentsQ = useQuery({ queryKey: ["agents"], queryFn: agents.list, staleTime: 60_000 });
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaces.list(),
    staleTime: 30_000,
  });

  const createM = useMutation({
    mutationFn: ({
      choice,
      folder,
      workspace,
    }: {
      choice: Choice;
      folder: string;
      workspace: WindowWorkspace;
    }) => {
      if (!host) throw new Error("The host is not known yet");
      return createWindow({
        host,
        cwd: folder,
        agent: choice.kind === "agent" ? choice.agent : null,
        workspace,
      });
    },
    onSuccess: ({ session, workspaceId, tabId }) => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      queryClient.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      const search = new URLSearchParams();
      if (tabId) search.set("tab", tabId);
      search.set("focus", session.id);
      router.push(`/w/${workspaceId}?${search.toString()}`);
    },
    onError: (error) => {
      toast.error(
        isWorkspaceFullError(error)
          ? "This workspace is full. Remove a window before adding another session."
          : error instanceof Error
            ? error.message
            : String(error),
      );
    },
  });

  const open = (choice: Choice, folder: string, workspace: WindowWorkspace) => {
    if (!host || host.status !== "online" || createM.isPending) return;
    hostUpdate.promptHostUpdate(host, () => createM.mutate({ choice, folder, workspace }));
  };

  /** The last question: which workspace, for a window whose what and where are settled. */
  const workspaceStep = (choice: Choice, folder: string): CascadePanel => {
    const last = lastWorkspaceId();
    return {
      id: `workspace-${choiceKey(choice)}-${folder}`,
      title: "Open in which workspace?",
      loading: workspacesQ.isLoading,
      items: [
        ...workspaceChoices(workspacesQ.data ?? [], last).map((workspace): CascadeItem => {
          const full = !workspaceHasRoom(workspace.layout);
          return {
            key: workspace.id,
            icon: <LayoutGrid />,
            label: workspace.name,
            detail: full ? "Full" : workspace.id === last ? "Last used" : undefined,
            disabled: full,
            onSelect: () => open(choice, folder, { id: workspace.id }),
          };
        }),
        {
          key: "new",
          icon: <Plus />,
          label: "New workspace",
          detail: "Starts with this window",
          onSelect: () => open(choice, folder, { new: true }),
        },
      ],
    };
  };

  /** "Which agent?", each agent leading to `next`. */
  const agentPanel = (
    id: string,
    next: (choice: Choice) => Pick<CascadeItem, "panel" | "onSelect">,
  ): CascadePanel => ({
    id,
    title: "Which agent?",
    loading: agentsQ.isLoading,
    emptyLabel: "No agents are defined. Add one in Settings → Agents.",
    items: (agentsQ.data ?? []).map((agent) => ({
      key: agent.id,
      icon: <AgentIcon kind={agent.kind} size={18} className="rounded" />,
      label: agent.name,
      detail: agent.command,
      ...next({ kind: "agent", agent }),
    })),
  });

  return {
    open,
    workspaceStep,
    agentPanel,
    agents: agentsQ.data ?? [],
    agentsLoading: agentsQ.isLoading,
    overlays: <HostUpdateDialog {...hostUpdate.dialogProps} />,
  };
}

/** The first step from a folder: a terminal there, or an agent. */
function folderPanel(
  folder: string,
  next: (choice: Choice) => Pick<CascadeItem, "panel" | "onSelect">,
  agentPanel: ReturnType<typeof useOpenHere>["agentPanel"],
): CascadePanel {
  return {
    id: "open-here",
    title: displayPath(folder),
    items: [
      {
        key: "shell",
        icon: <SquareTerminal />,
        label: OPEN_TERMINAL_HERE_LABEL,
        detail: "A plain login shell",
        ...next({ kind: "shell" }),
      },
      {
        key: "agent",
        icon: <Bot />,
        // The ellipsis: more questions follow, as "New window here…" says.
        label: START_AGENT_HERE_LABEL,
        panel: agentPanel("open-here-agents", next),
      },
    ],
  };
}

/**
 * "New window here…" — a window on this host, opened from its page.
 *
 * Three questions, each a step of one cascade: what it runs, where on this
 * host — the step a folder row answers already, so from one it is skipped —
 * and which workspace it opens in (the one used last first). The phone asks
 * them in the same order. Then the window opens there through the same
 * `createWindow` every other "+" uses, and this tab goes to it.
 *
 * `disabledReason` shuts it and says why, for a host whose connections are
 * blocked or that is not online.
 */
export function OpenHereMenu({
  host,
  cwd,
  trigger,
  disabledReason,
  className,
}: {
  host: Host;
  /** The folder, when the menu is opened from one; asked for otherwise. */
  cwd?: string;
  trigger: ReactElement;
  disabledReason?: string | null;
  className?: string;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<CascadeMenuHandle>(null);
  const reasonId = useId();
  /**
   * A folder browsed to with "Choose a folder…". The cascade closed for the
   * browser, so it opens again with the one question left as its first step.
   */
  const [browsed, setBrowsed] = useState<{ choice: Choice; folder: string } | null>(null);
  const here = useOpenHere(host);
  const where = useWherePanel({ hostId: host.id, anchorRef });

  /** What it runs is settled: next, where on this host — unless a folder said. */
  const afterWhat = (choice: Choice): CascadePanel =>
    cwd !== undefined
      ? here.workspaceStep(choice, cwd)
      : where.panel(
          `where-${choiceKey(choice)}`,
          (_host, folder) => {
            setBrowsed({ choice, folder });
            menuRef.current?.open();
          },
          `Where on ${host.name}?`,
          (_host, folder) => here.workspaceStep(choice, folder),
        );

  const agentItem = (agent: Agent): CascadeItem => ({
    key: agent.id,
    icon: <AgentIcon kind={agent.kind} size={18} className="rounded" />,
    label: agent.name,
    detail: agent.command,
    panel: afterWhat({ kind: "agent", agent }),
  });

  const root: CascadePanel = browsed
    ? here.workspaceStep(browsed.choice, browsed.folder)
    : cwd !== undefined
      ? folderPanel(cwd, (choice) => ({ panel: afterWhat(choice) }), here.agentPanel)
      : {
          id: "new-window-here",
          title: `New window on ${host.name}`,
          loading: here.agentsLoading,
          items: [
            {
              key: "shell",
              icon: <SquareTerminal />,
              label: "Shell",
              detail: "A plain login shell",
              panel: afterWhat({ kind: "shell" }),
            },
            ...here.agents.map(agentItem),
          ],
        };

  const blocked = Boolean(disabledReason);
  return (
    <span ref={anchorRef} className={cn("relative inline-flex", className)}>
      {blocked ? (
        // Shut, but still focusable, so a keyboard reaches the reason and the
        // pointer gets it as a title.
        <>
          <Slot
            aria-disabled="true"
            aria-describedby={reasonId}
            title={disabledReason ?? undefined}
            className="cursor-not-allowed opacity-50 hover:bg-transparent"
          >
            {trigger}
          </Slot>
          <span id={reasonId} className="sr-only">
            {disabledReason}
          </span>
        </>
      ) : (
        <CascadeMenu
          ref={menuRef}
          root={root}
          align="end"
          sheetTitle={root.title}
          // Opened afresh, it starts from what again.
          onOpenChange={(isOpen) => {
            if (!isOpen) setBrowsed(null);
          }}
          renderTrigger={(props) => <Slot {...props}>{trigger}</Slot>}
        />
      )}
      {where.overlays}
      {here.overlays}
    </span>
  );
}

export interface OpenHereLauncherHandle {
  /**
   * "Open terminal here" or "Start agent here…" for `folder`, the menu hanging
   * off a point (the menu it was chosen from). A window opened from inside a
   * workspace lands in it; anywhere else it asks which workspace.
   */
  open(folder: string, what: "terminal" | "agent", at: { x: number; y: number }): void;
}

/** The open-here questions, started from someone else's menu: the file browser's. */
export const OpenHereLauncher = forwardRef<
  OpenHereLauncherHandle,
  { host: Host | null; workspaceId?: string | null }
>(function OpenHereLauncher({ host, workspaceId }, ref) {
  const menuRef = useRef<CascadeMenuHandle>(null);
  const [request, setRequest] = useState<{ folder: string; what: "terminal" | "agent" } | null>(
    null,
  );
  const here = useOpenHere(host);
  const hereRef = useRef(here);
  hereRef.current = here;

  /** A choice made: into this workspace when there is one, else ask which. */
  const next =
    (folder: string) =>
    (choice: Choice): Pick<CascadeItem, "panel" | "onSelect"> =>
      workspaceId
        ? { onSelect: () => here.open(choice, folder, { id: workspaceId }) }
        : { panel: here.workspaceStep(choice, folder) };

  useImperativeHandle(
    ref,
    () => ({
      open: (folder, what, at) => {
        if (what === "terminal" && workspaceId) {
          hereRef.current.open({ kind: "shell" }, folder, { id: workspaceId });
          return;
        }
        setRequest({ folder, what });
        menuRef.current?.openAt(at.x, at.y);
      },
    }),
    [workspaceId],
  );

  const root: CascadePanel = !request
    ? { id: "open-here-idle", items: [] }
    : request.what === "agent"
      ? here.agentPanel("open-here-agents", next(request.folder))
      : here.workspaceStep({ kind: "shell" }, request.folder);

  return (
    <>
      <CascadeMenu
        ref={menuRef}
        root={root}
        sheetTitle={root.title}
        onOpenChange={(isOpen) => {
          if (!isOpen) setRequest(null);
        }}
        // Opened at a point from another menu: no trigger of its own.
        renderTrigger={() => (
          <span aria-hidden className="pointer-events-none absolute size-0 overflow-hidden" />
        )}
      />
      {here.overlays}
    </>
  );
});
