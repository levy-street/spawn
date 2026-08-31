import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { shellQuote } from "@/components/launcher/agent-command";
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
import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { qk } from "@/data/queryKeys";
import {
  agentInstallAndRunCommand,
  agentRunCommand,
  commandBasename,
  identifyAgent,
  isShellCommand,
  sortAgents,
} from "@/data/selectors/agent";
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

  const run = async (command: string, purpose: string) => {
    const result = await handoff({ session, terminal, command, purpose });
    if (result === "busy") onNotice(stillRunningMessage(session, purpose));
  };

  const agents = sortAgents(definitions.data ?? []);
  const installed = new Set(
    (availability.data?.agents ?? [])
      .filter((entry) => entry.installed)
      .map((entry) => entry.agent_id),
  );
  const foreground = session.foreground_command;
  const atShell = isShellCommand(foreground) || !commandBasename(foreground);

  const agentCommand = (agent: AgentOut): string =>
    installed.has(agent.id)
      ? agentRunCommand(agent)
      : (agentInstallAndRunCommand(agent) ?? agentRunCommand(agent));

  const actions: ActionSheetAction[] = [
    {
      id: "shell",
      label: "Shell",
      detail: "Back to a bare prompt",
      icon: <Icon name="SquareTerminal" />,
      selected: atShell,
      disabled: atShell,
      accessibilityRole: "radio",
      onPress: () => void run("", "Returning to the shell"),
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
        onPress: () => void run(agentCommand(agent), `Running ${agent.name}`),
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
