"use client";

import { Slot } from "@radix-ui/react-slot";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, LayoutGrid, Plus, SquareTerminal } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useId, useRef, useState } from "react";
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
  const router = useRouter();
  const queryClient = useQueryClient();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<CascadeMenuHandle>(null);
  const reasonId = useId();
  /**
   * A folder browsed to with "Choose a folder…". The cascade closed for the
   * browser, so it opens again with the one question left as its first step.
   */
  const [browsed, setBrowsed] = useState<{ choice: Choice; folder: string } | null>(null);
  const hostUpdate = useHostUpdate(null);
  const agentsQ = useQuery({ queryKey: ["agents"], queryFn: agents.list, staleTime: 60_000 });
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaces.list(),
    staleTime: 30_000,
  });
  const where = useWherePanel({ hostId: host.id, anchorRef });

  const createM = useMutation({
    mutationFn: ({
      choice,
      folder,
      workspace,
    }: {
      choice: Choice;
      folder: string;
      workspace: WindowWorkspace;
    }) =>
      createWindow({
        host,
        cwd: folder,
        agent: choice.kind === "agent" ? choice.agent : null,
        workspace,
      }),
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
    if (host.status !== "online" || createM.isPending) return;
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

  /** What it runs is settled: next, where on this host — unless a folder said. */
  const afterWhat = (choice: Choice): CascadePanel =>
    cwd !== undefined
      ? workspaceStep(choice, cwd)
      : where.panel(
          `where-${choiceKey(choice)}`,
          (_host, folder) => {
            setBrowsed({ choice, folder });
            menuRef.current?.open();
          },
          `Where on ${host.name}?`,
          (_host, folder) => workspaceStep(choice, folder),
        );

  const agentItem = (agent: Agent): CascadeItem => ({
    key: agent.id,
    icon: <AgentIcon kind={agent.kind} size={18} className="rounded" />,
    label: agent.name,
    detail: agent.command,
    panel: afterWhat({ kind: "agent", agent }),
  });
  const agentList = agentsQ.data ?? [];

  const root: CascadePanel = browsed
    ? workspaceStep(browsed.choice, browsed.folder)
    : cwd !== undefined
      ? {
          id: "open-here",
          title: displayPath(cwd),
          items: [
            {
              key: "shell",
              icon: <SquareTerminal />,
              label: "Open a shell here",
              detail: "A plain login shell",
              panel: afterWhat({ kind: "shell" }),
            },
            {
              key: "agent",
              icon: <Bot />,
              // The ellipsis: more questions follow, as "New window here…" says.
              label: "Start an agent here…",
              panel: {
                id: "open-here-agents",
                title: "Which agent?",
                loading: agentsQ.isLoading,
                emptyLabel: "No agents are defined. Add one in Settings → Agents.",
                items: agentList.map(agentItem),
              },
            },
          ],
        }
      : {
          id: "new-window-here",
          title: `New window on ${host.name}`,
          loading: agentsQ.isLoading,
          items: [
            {
              key: "shell",
              icon: <SquareTerminal />,
              label: "Shell",
              detail: "A plain login shell",
              panel: afterWhat({ kind: "shell" }),
            },
            ...agentList.map(agentItem),
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
      <HostUpdateDialog {...hostUpdate.dialogProps} />
    </span>
  );
}
