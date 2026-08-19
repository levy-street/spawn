"use client";

import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { type RefObject, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { AgentIcon } from "@/components/icons/AgentIcon";
import type { TerminalHandle } from "@/components/terminal/Terminal";
import { agents, hosts, type Session } from "@/lib/api";
import { cn } from "@/lib/utils";
import { shortcutBarPosition, shortcutBarVisible } from "./shortcut-bar-helpers";
import { agentInstallAndRunCommand, agentRunCommand } from "./shortcut-command";

export function ShortcutBar({
  session,
  promptState,
  containerRef,
  getHandle,
  subscribeCursorMove,
  className,
}: {
  session: Session;
  promptState: "empty" | "typing";
  containerRef: RefObject<HTMLElement | null>;
  getHandle: () => TerminalHandle | null;
  subscribeCursorMove: (callback: () => void) => () => void;
  className?: string;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const definitionsQ = useQuery({
    queryKey: ["agents"],
    queryFn: agents.list,
    staleTime: 5 * 60_000,
  });
  const availabilityQ = useQuery({
    queryKey: ["host-agents", session.host_id],
    queryFn: () => hosts.agents(session.host_id),
    staleTime: 5 * 60_000,
    refetchOnMount: "always",
  });

  const definitions = useMemo(
    () =>
      [...(definitionsQ.data ?? [])].sort((a, b) => {
        const builtIn = Number(a.owner_user_id !== null) - Number(b.owner_user_id !== null);
        return builtIn || a.name.localeCompare(b.name);
      }),
    [definitionsQ.data],
  );
  const availability = useMemo(
    () => new Map((availabilityQ.data?.agents ?? []).map((item) => [item.agent_id, item])),
    [availabilityQ.data],
  );
  const checkingAvailability = availabilityQ.isLoading && availabilityQ.data === undefined;
  const allowed = shortcutBarVisible(session, promptState);

  const place = useCallback(() => {
    const popup = popupRef.current;
    const container = containerRef.current;
    if (!popup || !container || !allowed) return;
    const cursor = getHandle()?.getCursorRect() ?? null;
    if (!cursor) {
      popup.style.visibility = "hidden";
      return;
    }
    const pane = container.getBoundingClientRect();
    popup.style.maxWidth = `${Math.max(0, pane.width - 16)}px`;
    const measured = popup.getBoundingClientRect();
    const position = shortcutBarPosition(
      cursor,
      pane.width,
      pane.height,
      measured.width,
      measured.height || 44,
    );
    popup.style.left = `${position.left}px`;
    popup.style.top = `${position.top}px`;
    popup.style.visibility = "visible";
    popup.dataset.flipped = String(position.flipped);
  }, [allowed, containerRef, getHandle]);

  const schedulePlace = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      place();
    });
  }, [place]);

  useLayoutEffect(() => {
    if (!allowed) return;
    const container = containerRef.current;
    if (!container) return;
    schedulePlace();
    const unsubscribe = subscribeCursorMove(schedulePlace);
    const observer = new ResizeObserver(schedulePlace);
    observer.observe(container);
    if (popupRef.current) observer.observe(popupRef.current);
    container.addEventListener("scroll", schedulePlace, true);
    window.addEventListener("resize", schedulePlace);
    return () => {
      unsubscribe();
      observer.disconnect();
      container.removeEventListener("scroll", schedulePlace, true);
      window.removeEventListener("resize", schedulePlace);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [allowed, containerRef, schedulePlace, subscribeCursorMove]);

  if (!allowed || definitions.length === 0) return null;

  const launch = (agent: (typeof definitions)[number]) => {
    const handle = getHandle();
    if (!handle) return;
    const installed = availability.get(agent.id)?.installed === true;
    const command = installed
      ? agentRunCommand(agent)
      : (agentInstallAndRunCommand(agent) ?? agentRunCommand(agent));
    handle.focus();
    handle.sendInput(`${command}\n`);
    requestAnimationFrame(() => handle.focus());
  };

  return (
    <div
      ref={popupRef}
      role="toolbar"
      aria-label="Agent shortcuts"
      className={cn(
        "absolute z-30 flex max-w-[calc(100%-1rem)] items-center gap-1 overflow-x-auto rounded-lg border border-border bg-popover/90 p-1 text-popover-foreground shadow-lg backdrop-blur",
        "invisible overscroll-contain",
        className,
      )}
    >
      {definitions.map((agent) => {
        const installed = availability.get(agent.id)?.installed === true;
        const installable = !installed && Boolean(agent.install?.trim());
        return (
          <button
            key={agent.id}
            type="button"
            tabIndex={-1}
            disabled={checkingAvailability}
            title={
              checkingAvailability
                ? `Checking ${agent.name} availability`
                : installed
                  ? `Run ${agent.name}`
                  : `Install and run ${agent.name}`
            }
            aria-label={
              checkingAvailability
                ? `Checking ${agent.name} availability`
                : installed
                  ? `Run ${agent.name}`
                  : `Install and run ${agent.name}`
            }
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => launch(agent)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border/70 bg-background/75 px-2 text-xs font-medium transition-colors hover:bg-accent active:bg-accent disabled:opacity-60 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:px-3"
          >
            <AgentIcon kind={agent.kind} command={agent.command} size={20} className="rounded-md" />
            <span>{agent.name}</span>
            {checkingAvailability ? (
              <span className="text-muted-foreground">checking…</span>
            ) : !installed ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Download className="size-3" aria-hidden />
                <span>{installable ? "install & run" : "run"}</span>
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
