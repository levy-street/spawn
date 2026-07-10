"use client";

import { type DragEvent, useRef, useState } from "react";

/** Custom mime for dragging agents out of the sidebar tree. */
export const AGENT_DRAG_MIME = "application/x-spawn-agent";
/** Set when the drag source is an existing pane; carries the source tab index. */
export const PANE_SRC_MIME = "application/x-spawn-pane-src";

export function dragHasAgent(dataTransfer: DataTransfer | null): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types).includes(AGENT_DRAG_MIME);
}

export function setAgentDragData(
  dataTransfer: DataTransfer,
  agentId: string,
  title: string,
  sourceTab?: number,
) {
  dataTransfer.setData(AGENT_DRAG_MIME, agentId);
  dataTransfer.setData("text/plain", title);
  if (sourceTab !== undefined) dataTransfer.setData(PANE_SRC_MIME, String(sourceTab));
  dataTransfer.effectAllowed = sourceTab === undefined ? "copy" : "move";
}

export function dragIsPane(dataTransfer: DataTransfer | null): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types).includes(PANE_SRC_MIME);
}

export function paneSourceTab(dataTransfer: DataTransfer): number | null {
  const raw = dataTransfer.getData(PANE_SRC_MIME);
  if (raw === "") return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Drop-zone hook for agent drags. Enter/leave events fire for every child the
 * pointer crosses (including xterm internals), so a depth counter keeps the
 * highlight stable until the drag truly exits the zone.
 */
export function useAgentDrop(
  onDropAgent: (agentId: string, title: string, sourceTab: number | null) => void,
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
      if (agentId) onDropAgent(agentId, title, paneSourceTab(event.dataTransfer));
    },
  };

  return { active, dropProps };
}
