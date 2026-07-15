"use client";

import { type DragEvent, useCallback, useRef, useState } from "react";

/** Custom mime for dragging agents out of the sidebar tree. */
export const AGENT_DRAG_MIME = "application/x-spawn-agent";
/** Set when the drag source is an existing pane; carries the source screen id. */
export const PANE_SRC_MIME = "application/x-spawn-pane-src";

export function dragHasAgent(dataTransfer: DataTransfer | null): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types).includes(AGENT_DRAG_MIME);
}

export function setAgentDragData(
  dataTransfer: DataTransfer,
  agentId: string,
  title: string,
  sourceScreen?: string,
) {
  dataTransfer.setData(AGENT_DRAG_MIME, agentId);
  dataTransfer.setData("text/plain", title);
  if (sourceScreen !== undefined) dataTransfer.setData(PANE_SRC_MIME, sourceScreen);
  dataTransfer.effectAllowed = sourceScreen === undefined ? "copy" : "move";
}

export function dragIsPane(dataTransfer: DataTransfer | null): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types).includes(PANE_SRC_MIME);
}

export function paneSourceScreen(dataTransfer: DataTransfer): string | null {
  const raw = dataTransfer.getData(PANE_SRC_MIME);
  return raw === "" ? null : raw;
}

/**
 * Drop-zone hook for agent drags. Enter/leave events fire for every child the
 * pointer crosses (including xterm internals), so a depth counter keeps the
 * highlight stable until the drag truly exits the zone.
 */
export function useAgentDrop(
  onDropAgent: (agentId: string, title: string, sourceScreen: string | null) => void,
) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  const dropProps = {
    onDragEnter: (event: DragEvent<HTMLElement>) => {
      if (!dragHasAgent(event.dataTransfer)) return;
      event.preventDefault();
      depth.current += 1;
      setActive(true);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!dragHasAgent(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!dragHasAgent(event.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!dragHasAgent(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      depth.current = 0;
      setActive(false);
      const agentId = event.dataTransfer.getData(AGENT_DRAG_MIME);
      const title = event.dataTransfer.getData("text/plain");
      if (agentId) onDropAgent(agentId, title, paneSourceScreen(event.dataTransfer));
    },
  };

  // A ref-callback variant using NATIVE listeners. React synthetic events don't
  // bubble across portals by DOM ancestry — and the terminal is portaled from
  // the root pool — so a drop onto the terminal never reaches a page's React
  // onDrop. Native listeners on the DOM container catch it, since the terminal
  // is physically nested inside. Attach with `ref={dropRef}`.
  const cbRef = useRef(onDropAgent);
  cbRef.current = onDropAgent;
  const cleanupRef = useRef<(() => void) | null>(null);
  const dropRef = useCallback((el: HTMLElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!el) return;
    const onEnter = (e: globalThis.DragEvent) => {
      if (!dragHasAgent(e.dataTransfer)) return;
      e.preventDefault();
      depth.current += 1;
      setActive(true);
    };
    const onOver = (e: globalThis.DragEvent) => {
      if (!dragHasAgent(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: globalThis.DragEvent) => {
      if (!dragHasAgent(e.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const onDrop = (e: globalThis.DragEvent) => {
      if (!dragHasAgent(e.dataTransfer) || !e.dataTransfer) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current = 0;
      setActive(false);
      const agentId = e.dataTransfer.getData(AGENT_DRAG_MIME);
      const title = e.dataTransfer.getData("text/plain");
      if (agentId) cbRef.current(agentId, title, paneSourceScreen(e.dataTransfer));
    };
    el.addEventListener("dragenter", onEnter);
    el.addEventListener("dragover", onOver);
    el.addEventListener("dragleave", onLeave);
    el.addEventListener("drop", onDrop);
    cleanupRef.current = () => {
      el.removeEventListener("dragenter", onEnter);
      el.removeEventListener("dragover", onOver);
      el.removeEventListener("dragleave", onLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, []);

  return { active, dropProps, dropRef };
}
