"use client";

import { type DragEvent, useRef, useState } from "react";

/** Custom mime for dragging agents out of the sidebar tree. */
export const AGENT_DRAG_MIME = "application/x-spawn-agent";

export function dragHasAgent(dataTransfer: DataTransfer | null): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types).includes(AGENT_DRAG_MIME);
}

export function setAgentDragData(dataTransfer: DataTransfer, agentId: string, title: string) {
  dataTransfer.setData(AGENT_DRAG_MIME, agentId);
  dataTransfer.setData("text/plain", title);
  dataTransfer.effectAllowed = "copy";
}

/**
 * Drop-zone hook for agent drags. Enter/leave events fire for every child the
 * pointer crosses (including xterm internals), so a depth counter keeps the
 * highlight stable until the drag truly exits the zone.
 */
export function useAgentDrop(onDropAgent: (agentId: string, title: string) => void) {
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
      if (agentId) onDropAgent(agentId, title);
    },
  };

  return { active, dropProps };
}
