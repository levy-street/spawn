"use client";

import { Check, MoreHorizontal, RefreshCw, Upload } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { useState } from "react";
import { AgentKindIcon } from "@/components/agents/AgentKindIcon";
import { AgentPaneMenuItems } from "@/components/agents/AgentPaneMenu";
import { type AgentConnectionInfo, ConnectionChip } from "@/components/terminal/ConnectionChip";
import type { TerminalHandle } from "@/components/terminal/Terminal";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { AgentStatusDot } from "@/components/ui/status";
import { agentActivityDetail, agentNeedsAttention, agentTitle } from "@/lib/agents";
import type { Agent } from "@/lib/api";
import { runDiagnosticRefresh } from "@/lib/diagnostics";
import { cn } from "@/lib/utils";

/**
 * The header shared by the full agent page and every screen pane — the one
 * place agent identity, connection, diagnostics, and actions are rendered, so
 * a pane and the standalone view feel like the same surface at two sizes.
 *
 * The page passes a back button as `leading` and a files toggle as `trailing`;
 * a pane passes a drag handle as `leading` and zoom/remove as `trailing`.
 * Everything between — icon, status, attention, name, meta, connection chip,
 * viewer state, refresh-diagnostics, and the actions menu — is identical.
 */
export function AgentSurfaceHeader({
  agent,
  connInfo,
  displayOwner,
  dense = false,
  leading,
  trailing,
  titleSlot,
  meta,
  getHandle,
  onError,
  onStartRename,
  onDeleted,
  headerProps,
}: {
  agent: Agent;
  connInfo: AgentConnectionInfo | null;
  /** Pane variant: false shows a "viewer" chip (another window owns geometry). */
  displayOwner?: boolean | null;
  dense?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Inline name editor (page edit mode); falls back to a title button. */
  titleSlot?: ReactNode;
  /** Extra meta line shown under the name on the non-dense (page) variant. */
  meta?: ReactNode;
  getHandle: () => TerminalHandle | null;
  onError: (message: string) => void;
  onStartRename?: () => void;
  onDeleted?: () => void;
  /** Spread onto the <header> — lets a pane make its header the drag handle. */
  headerProps?: HTMLAttributes<HTMLElement>;
}) {
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagSaved, setDiagSaved] = useState(false);
  const attention = agentNeedsAttention(agent);

  const refresh = async () => {
    const handle = getHandle();
    if (!handle || diagBusy) return;
    setDiagBusy(true);
    setDiagSaved(false);
    try {
      await runDiagnosticRefresh(handle);
      setDiagSaved(true);
      setTimeout(() => setDiagSaved(false), 2500);
    } catch (err) {
      onError(`diagnostic refresh: ${String(err)}`);
    } finally {
      setDiagBusy(false);
    }
  };

  const iconSize = dense ? "size-5" : "size-7";
  const btn =
    "grid shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground";
  const btnSize = dense ? "size-6" : "size-8";

  return (
    <header
      {...headerProps}
      className={cn(
        "flex shrink-0 items-center gap-1.5 border-b border-border bg-card/60",
        dense ? "h-8 px-2" : "h-12 gap-2 bg-background/95 px-2 pad-safe-x sm:px-3",
        headerProps?.className,
      )}
    >
      {leading}
      <span className="relative shrink-0">
        <AgentKindIcon
          agent={agent}
          className={iconSize}
          iconClassName={dense ? "size-3" : undefined}
        />
        <AgentStatusDot
          agent={agent}
          className={cn("absolute -bottom-0.5 -right-0.5", dense && "size-1.5")}
        />
      </span>

      <div className="min-w-0 flex-1">
        {titleSlot ?? (
          <button
            type="button"
            title={onStartRename ? "Rename agent" : agentTitle(agent)}
            onClick={onStartRename}
            className={cn(
              "flex max-w-full items-center gap-1 truncate rounded px-0.5 text-left font-medium leading-5",
              dense ? "text-xs" : "text-sm",
              onStartRename && "hover:bg-accent/50",
            )}
          >
            <span className="truncate">{agentTitle(agent)}</span>
            {attention && (
              <span
                title={attention === "dead" ? "Agent exited" : "Awaiting input"}
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  attention === "dead" ? "bg-red-500" : "animate-pulse bg-amber-400",
                )}
              />
            )}
          </button>
        )}
        {!dense && meta}
        {dense && <span className="sr-only">{agentActivityDetail(agent)}</span>}
      </div>

      {dense && (
        <span className="hidden min-w-0 truncate text-[10px] text-muted-foreground lg:inline">
          {agentActivityDetail(agent)}
        </span>
      )}
      {displayOwner === false && (
        <span
          title="Another window controls this terminal's size"
          className="shrink-0 rounded border border-border px-1 text-[9px] uppercase tracking-wide text-muted-foreground"
        >
          viewer
        </span>
      )}
      <ConnectionChip info={connInfo} compact className={dense ? undefined : "sm:hidden"} />
      {!dense && <ConnectionChip info={connInfo} className="hidden sm:block" />}
      {trailing}
      <button
        type="button"
        aria-label="Upload files"
        title="Upload files to this agent"
        onClick={() => getHandle()?.openUpload()}
        className={cn(btn, btnSize)}
      >
        <Upload className={dense ? "size-3" : "size-4"} aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Refresh terminal"
        title={
          diagSaved
            ? "Diagnostics saved to the agent host"
            : "Refresh terminal (saves before/after diagnostics)"
        }
        disabled={diagBusy}
        onClick={refresh}
        className={cn(btn, btnSize)}
      >
        {diagSaved ? (
          <Check className={cn(dense ? "size-3" : "size-4", "text-emerald-500")} />
        ) : (
          <RefreshCw className={cn(dense ? "size-3" : "size-4", diagBusy && "animate-spin")} />
        )}
      </button>
      <DropdownMenu
        align="end"
        menuClassName="w-64"
        renderTrigger={(props) => (
          <button
            {...props}
            type="button"
            aria-label={`${agentTitle(agent)} actions`}
            className={cn(btn, btnSize)}
          >
            <MoreHorizontal className={dense ? "size-3" : "size-4"} />
          </button>
        )}
      >
        <AgentPaneMenuItems
          agent={agent}
          getHandle={getHandle}
          onError={onError}
          onDeleted={onDeleted}
        />
      </DropdownMenu>
    </header>
  );
}
