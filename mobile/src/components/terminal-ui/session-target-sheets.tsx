import { useQuery, useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { useCallback, useState } from "react";

import {
  agentInstallAndLaunchCommand,
  agentLaunchCommand,
  newAgentConversationId,
  shellQuote,
} from "@/components/launcher/agent-command";
import { FolderPicker } from "@/components/launcher/folder-picker";
import { pathFlavorForHostOS } from "@/components/launcher/folder-picker-logic";
import type { ShellCommandSink } from "@/components/launcher/shell-handoff";
import { stillRunningMessage } from "@/components/launcher/shell-handoff";
import { useShellHandoff } from "@/components/launcher/use-shell-handoff";
import { ActionSheet, type ActionSheetAction } from "@/components/ui/action-sheet";
import { Icon } from "@/components/ui/icon";
import { Sheet, SheetHeader } from "@/components/ui/sheet";
import { AgentIcon } from "@/components/workspace-detail/agent-icon";
import { listAgents } from "@/data/api/endpoints/agents";
import { listHostAgents, listRecentDirectories } from "@/data/api/endpoints/hosts";
import { patchSession } from "@/data/api/endpoints/sessions";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { qk } from "@/data/queryKeys";
import { commandBasename, identifyAgent, isShellCommand, sortAgents } from "@/data/selectors/agent";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import type { HostTransport, TransportState } from "@/terminal/transport/types";
import { sizing } from "@/theme/sizing";

const AGENT_STALE_MS = 5 * 60_000;

export interface SessionTargetSheetsProps {
  session: SessionOut;
  host: HostOut;
  /** The live terminal the chosen command is typed into; null while it is away. */
  terminal: ShellCommandSink | null;
  folderVisible: boolean;
  agentVisible: boolean;
  onDismissFolder: () => void;
  onDismissAgent: () => void;
  onNotice: (message: string) => void;
}

/**
 * The two things a running window can be re-pointed at: its folder, and what is
 * running in it — the controls the desktop pane header carries, in the shape a
 * phone can hold them.
 *
 * Neither is a hidden side channel. Both type a command at this shell's prompt
 * exactly as if it had been typed by hand, and when an agent already holds the
 * keyboard `runInShell` asks before interrupting it. An agent the host does not
 * have types its install command visibly chained in front.
 */
export function SessionTargetSheets({
  session,
  host,
  terminal,
  folderVisible,
  agentVisible,
  onDismissFolder,
  onDismissAgent,
  onNotice,
}: SessionTargetSheetsProps): React.JSX.Element {
  const handoff = useShellHandoff();
  const queryClient = useQueryClient();
  const [transport, setTransport] = useState<HostTransport | null>(null);
  const [transportState, setTransportState] = useState<TransportState>("idle");
  const definitions = useQuery({
    queryKey: qk.agents(),
    queryFn: listAgents,
    staleTime: AGENT_STALE_MS,
    enabled: agentVisible,
  });
  const availability = useQuery({
    queryKey: qk.hostAgents(host.id),
    queryFn: () => listHostAgents(host.id),
    staleTime: AGENT_STALE_MS,
    enabled: agentVisible,
  });
  const recents = useQuery({
    queryKey: qk.hostFolders(host.id, "recent"),
    queryFn: async () => (await listRecentDirectories(host.id)).dirs,
    enabled: folderVisible,
  });

  const handleTransport = useCallback((next: HostTransport) => setTransport(next), []);

  /**
   * Type a command into this window's shell, and — when it lands — record what
   * kind of window that makes it. The type outlives the process: the
   * foreground goes back to a shell the moment the agent is quit, and reports
   * an interpreter's name for any CLI that ships as a script. A duplicate
   * reads the recorded type, so this is what makes a copy of a Hermes window a
   * Hermes window. Best-effort: a window whose type failed to save still has
   * the agent running in it.
   */
  const run = async (
    command: string,
    purpose: string,
    /** Omitted where the command changes what the window is doing but not what
     *  it is — a `cd` is not a change of type. */
    retype?: { agentId: string | null; conversationId: string | null },
  ) => {
    const result = await handoff({ session, terminal, command, purpose });
    if (result === "busy") {
      onNotice(stillRunningMessage(session, purpose));
      return;
    }
    if (result !== "sent" || retype === undefined) return;
    try {
      const saved = await patchSession(session.id, {
        agent_id: retype.agentId,
        agent_session_id: retype.conversationId,
      });
      queryClient.setQueryData(qk.session(session.id), saved);
      void queryClient.invalidateQueries({ queryKey: qk.sessions() });
    } catch {
      // The type is a convenience the running agent does not depend on.
    }
  };

  const agents = sortAgents(definitions.data ?? []);
  const installed = new Set(
    (availability.data?.agents ?? [])
      .filter((entry) => entry.installed)
      .map((entry) => entry.agent_id),
  );
  const foreground = session.foreground_command;
  const atShell = isShellCommand(foreground) || !commandBasename(foreground);

  const agentCommand = (agent: AgentOut, conversation: string | null): string =>
    installed.has(agent.id)
      ? agentLaunchCommand(agent, conversation)
      : (agentInstallAndLaunchCommand(agent, conversation) ??
        agentLaunchCommand(agent, conversation));

  const actions: ActionSheetAction[] = [
    {
      id: "shell",
      label: "Shell",
      detail: "Back to a bare prompt",
      icon: <Icon name="SquareTerminal" />,
      selected: atShell,
      disabled: atShell,
      accessibilityRole: "radio",
      // Deliberately back at a prompt: a shell window again, and a
      // duplicate of it should be one.
      onPress: () =>
        void run("", "Returning to the shell", { agentId: null, conversationId: null }),
    },
    ...agents.map((agent): ActionSheetAction => {
      const current = commandBasename(agent.command) === commandBasename(foreground);
      return {
        id: agent.id,
        label: agent.name,
        detail: installed.has(agent.id) ? agent.command : "Installs first, then runs",
        icon: (
          <AgentIcon
            identity={identifyAgent(agent.command, [agent])}
            size={sizing.actionSheet.icon}
          />
        ),
        selected: current,
        accessibilityRole: "radio",
        onPress: () => {
          // A launch is a new conversation: named up front where the CLI lets
          // us, so a restart later can resume this one rather than "the latest".
          const conversation = newAgentConversationId(agent.kind, randomUUID);
          void run(agentCommand(agent, conversation), `Running ${agent.name}`, {
            agentId: agent.id,
            conversationId: conversation,
          });
        },
      };
    }),
  ];

  return (
    <>
      <Sheet onDismiss={onDismissFolder} size="tall" visible={folderVisible}>
        <SheetHeader title="Change folder" />
        <FolderPicker
          initialPath={session.cwd}
          onSelect={(path) => {
            onDismissFolder();
            void run(`cd ${shellQuote(path)}`, "Changing this window's folder");
          }}
          // Without this the picker defaults to POSIX and mangles every path
          // on a Windows host — separators, the drive root, the home check.
          pathFlavor={pathFlavorForHostOS(host.os)}
          recentDirectories={recents.data ?? []}
          recentError={recents.error?.message ?? null}
          transport={transport}
          transportState={transportState}
        />
      </Sheet>
      {folderVisible && host.host_public_key ? (
        <HostTransportSurface
          hostId={host.id}
          hostIdentityPublicKey={host.host_public_key}
          onError={(error) => onNotice(error.message)}
          onStateChange={setTransportState}
          onTransport={handleTransport}
        />
      ) : null}
      <ActionSheet
        actions={actions}
        message={
          atShell
            ? "Types the agent's command at this shell's prompt."
            : "Stops what is running first, then types the command."
        }
        onDismiss={onDismissAgent}
        title="Run in this window"
        visible={agentVisible}
      />
    </>
  );
}
