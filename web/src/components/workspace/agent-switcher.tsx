"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Download, FolderTree, SquareTerminal } from "lucide-react";
import { AgentIcon, agentDisplayName, commandBasename } from "@/components/icons/AgentIcon";
import type { TerminalHandle } from "@/components/terminal/Terminal";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { type Agent, agents, hosts, type Session } from "@/lib/api";
import { sessionAtShell } from "@/lib/sessions";
import { cn } from "@/lib/utils";
import { agentInstallAndRunCommand, agentRunCommand } from "./agent-command";
import { runInShell } from "./shell-handoff";

/**
 * The pane header's identity icon, doubling as the agent-type switcher (§5.5).
 *
 * At rest it is exactly the icon the header always showed. Hovering the header
 * — the pane's drag bar — grows a plate and a chevron under it, and clicking
 * opens the list of agent types; picking one types that agent's command into
 * this shell. Nothing runs hidden: the command lands in the terminal exactly as
 * if it had been typed, and an agent missing from the host types its install
 * command visibly chained in front.
 *
 * The header must carry `group/pane-header` for the hover reveal to fire.
 */
export function AgentSwitcher({
  session,
  getHandle,
  size = 22,
  className,
  onConvertToFiles,
}: {
  session: Session;
  getHandle: () => TerminalHandle | null;
  size?: number;
  className?: string;
  /** Offered as "File explorer" in the menu: replace this pane with a files
   *  widget (workspace panes only — the grid owns the layout surgery). */
  onConvertToFiles?: () => void;
}) {
  const queryClient = useQueryClient();
  const definitionsQ = useQuery({
    queryKey: ["agents"],
    queryFn: agents.list,
    staleTime: 5 * 60_000,
  });
  const availabilityQ = useQuery({
    queryKey: ["host-agents", session.host_id],
    queryFn: () => hosts.agents(session.host_id),
    staleTime: 5 * 60_000,
  });

  // Built-ins first, then custom definitions, each alphabetical.
  const definitions = [...(definitionsQ.data ?? [])].sort((a, b) => {
    const builtIn = Number(a.owner_user_id !== null) - Number(b.owner_user_id !== null);
    return builtIn || a.name.localeCompare(b.name);
  });
  const availability = new Map(
    (availabilityQ.data?.agents ?? []).map((item) => [item.agent_id, item]),
  );

  const icon = (
    <AgentIcon command={session.foreground_command} size={size} className="rounded-md" />
  );
  if (definitions.length === 0) return <span className={cn("shrink-0", className)}>{icon}</span>;

  /*
   * An agent's command is typed at a shell prompt, so a shell has to be the
   * thing reading the keyboard. When another agent holds the foreground the
   * entries still work, but picking one asks first and then Ctrl-Cs its way
   * back to the prompt (`shell-handoff.ts`) — typing `codex` into Claude
   * Code's prompt would otherwise just be a message to Claude Code.
   */
  const atShell = sessionAtShell(session);
  const running = session.status === "running";
  const foreground = session.foreground_command;

  const launch = (agent: Agent) => {
    const handle = getHandle();
    if (!handle || !running) return;
    const installed = availability.get(agent.id)?.installed === true;
    const command = installed
      ? agentRunCommand(agent)
      : (agentInstallAndRunCommand(agent) ?? agentRunCommand(agent));
    void runInShell({ session, handle, command, purpose: `Running ${agent.name}` }).then(
      (result) => {
        if (result !== "sent") return;
        /*
         * Claim the foreground for the agent we just launched. The daemon
         * reports the real basename within a second or so, but the browser
         * only sees it on the next 5 s session poll — long enough for the
         * header to keep showing a shell over a running agent. Writing the
         * prediction into the cache flips the icon on the click instead, and
         * the poll reconciles: if the command never took the foreground (a
         * typo, a failed install), the server's value wins and the icon goes
         * back.
         */
        const basename = commandBasename(command);
        if (basename) writeForegroundToCache(queryClient, session.id, basename);
      },
    );
  };

  /** Back to a bare prompt: interrupt the agent, land on a cleared shell. */
  const stopToShell = () => {
    const handle = getHandle();
    if (!handle || !running) return;
    void runInShell({ session, handle, command: "", purpose: "Returning to the shell" }).then(
      (result) => {
        if (result === "sent") writeForegroundToCache(queryClient, session.id, null);
      },
    );
  };

  const foregroundName = agentDisplayName(foreground);
  const label = !running
    ? "Agent types (the shell is not running)"
    : atShell
      ? "Switch agent type"
      : `Switch agent type (stops ${foregroundName})`;

  return (
    <DropdownMenu
      align="start"
      className={cn("shrink-0", className)}
      menuClassName="w-64"
      renderTrigger={(triggerProps) => (
        <button
          {...triggerProps}
          type="button"
          title={label}
          aria-label={label}
          data-open={triggerProps["aria-expanded"] || undefined}
          className={cn(
            "group/agent-switcher flex shrink-0 items-center rounded-lg p-px transition-colors",
            "group-hover/pane-header:bg-accent/70",
            "hover:bg-accent focus-visible:bg-accent data-[open]:bg-accent",
          )}
        >
          {icon}
          {/* Collapsed to zero width at rest, so the header row is the bare
              icon until it is hovered — or the menu is open, or the pointer is
              coarse and has no hover to give. */}
          <ChevronDown
            aria-hidden
            className={cn(
              "h-3 w-0 shrink-0 overflow-hidden text-muted-foreground opacity-0",
              "transition-[width,opacity,margin] duration-150",
              "group-hover/pane-header:mx-px group-hover/pane-header:w-3 group-hover/pane-header:opacity-100",
              "group-hover/agent-switcher:mx-px group-hover/agent-switcher:w-3 group-hover/agent-switcher:opacity-100",
              "group-data-[open]/agent-switcher:mx-px group-data-[open]/agent-switcher:w-3 group-data-[open]/agent-switcher:opacity-100",
              "[@media(pointer:coarse)]:mx-px [@media(pointer:coarse)]:w-3 [@media(pointer:coarse)]:opacity-100",
            )}
          />
        </button>
      )}
    >
      <DropdownMenuLabel>
        {!running
          ? "This shell is not running"
          : atShell
            ? "Run in this shell"
            : `Stop ${foregroundName} and run`}
      </DropdownMenuLabel>
      <DropdownMenuItem disabled={!running || atShell} onSelect={stopToShell}>
        <SquareTerminal className="size-5 shrink-0 p-0.5 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate">Shell</span>
        {atShell && running && (
          <Check className="size-3.5 shrink-0 text-muted-foreground" aria-label="Running" />
        )}
      </DropdownMenuItem>
      {definitions.map((agent) => {
        const installed = availability.get(agent.id)?.installed === true;
        const installable = Boolean(agent.install?.trim());
        const current = foreground !== null && commandBasename(agent.command) === foreground;
        return (
          <DropdownMenuItem key={agent.id} disabled={!running} onSelect={() => launch(agent)}>
            <AgentIcon kind={agent.kind} command={agent.command} size={20} className="rounded-md" />
            <span className="min-w-0 flex-1 truncate">{agent.name}</span>
            {current ? (
              <Check className="size-3.5 shrink-0 text-muted-foreground" aria-label="Running" />
            ) : installed ? null : (
              <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <Download className="size-3" aria-hidden />
                {installable ? "install & run" : "run"}
              </span>
            )}
          </DropdownMenuItem>
        );
      })}
      {onConvertToFiles && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onConvertToFiles}>
            <FolderTree className="size-5 shrink-0 p-0.5 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">File explorer</span>
          </DropdownMenuItem>
        </>
      )}
    </DropdownMenu>
  );
}

/** Optimistic `foreground_command` write into both session caches. */
function writeForegroundToCache(
  queryClient: ReturnType<typeof useQueryClient>,
  sessionId: string,
  foregroundCommand: string | null,
): void {
  queryClient.setQueryData<Session>(["session", sessionId], (current) =>
    current ? { ...current, foreground_command: foregroundCommand } : current,
  );
  queryClient.setQueryData<Session[]>(["sessions"], (current) =>
    current?.map((item) =>
      item.id === sessionId ? { ...item, foreground_command: foregroundCommand } : item,
    ),
  );
}
