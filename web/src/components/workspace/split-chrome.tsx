"use client";

import { PanelLeftClose, PanelRightClose } from "lucide-react";
import { WorkspaceAvatar } from "@/components/nav/sidebar-parts";
import { Button } from "@/components/ui/button";
import type { SplitSide } from "@/lib/split-store";
import { cn } from "@/lib/utils";

/**
 * The two ends a tab strip grows when its window holds two workspaces: which
 * workspace this strip is showing, and the way back to one.
 *
 * Passed as a single optional prop rather than a handful of them so that the
 * ordinary window — the overwhelmingly common one — says nothing about split
 * view at all, and the strip it renders is the strip it has always rendered.
 */
export interface SplitChrome {
  workspaceName: string;
  workspaceIcon: string | null;
  side: SplitSide;
  /** Back to one workspace, keeping the half this strip belongs to. */
  onUnsplit: () => void;
}

/**
 * Both ends stay put while the tabs scroll between them, and cover whatever
 * passes underneath.
 *
 * Sticky inside the strip rather than sat outside it, because the strip's box
 * has to keep spanning the same width as the canvas below: the selected tab's
 * connected look is decided by mapping the tab's pixels onto grid columns
 * against the strip's own rect, so a strip narrowed by chrome either side
 * would map every tab onto the wrong columns.
 */
const PINNED = "sticky z-20 shrink-0 bg-shell";

/**
 * How far in from the strip's right edge the pinned controls come to rest.
 *
 * Zero, not the strip's own `pr-1.5`: a sticky inset is measured from the
 * scrollport already reduced by the scroll container's padding, so counting
 * that padding again lands each control 6px left of where the same element
 * sits in flow — and a strip that has not overflowed, where sticky should be
 * doing nothing at all, would quietly shift both of them. Measured in
 * Chromium rather than reasoned about; the two disagreed.
 */
export const PINNED_RIGHT = "right-0";

/**
 * Which workspace this half is. Two strips side by side carry tab names that
 * say nothing about whose tabs they are, and this is the only thing on screen
 * that answers that — but it is a label and not a target, so it stays quieter
 * than the tabs it introduces and truncates rather than crowding them out.
 */
export function SplitWorkspaceLabel({ name, icon }: { name: string; icon: string | null }) {
  return (
    <div
      // The strip's own accessible name already carries the workspace, so to a
      // screen reader this would be the same fact read twice; it is here for
      // the eye, which is what has two strips to tell apart.
      aria-hidden
      title={name}
      className={cn(PINNED, "left-0 flex h-8 items-center gap-1.5 pl-0.5 pr-2")}
    >
      <WorkspaceAvatar name={name} icon={icon} />
      <span className="max-w-28 truncate text-xs font-medium text-muted-foreground">{name}</span>
    </div>
  );
}

/**
 * Collapse back to one workspace, keeping this half. Both halves carry one;
 * what each of them does about it is the caller's business.
 */
export function UnsplitButton({
  workspaceName,
  side,
  onUnsplit,
}: {
  workspaceName: string;
  side: SplitSide;
  onUnsplit: () => void;
}) {
  // The icon draws the half that goes, not the half that stays: "keep this
  // one" and "close the other one" are the same act, and only the second has
  // a direction a picture can point in. So the left strip folds the right
  // panel away and the right strip folds the left one.
  const Icon = side === "primary" ? PanelRightClose : PanelLeftClose;
  const label = `Keep only ${workspaceName}`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      // A plain title rather than the rail's tooltip plate: on the right-hand
      // strip this button sits against the window's edge, which is exactly
      // where that plate — placed to the right of what it labels — has nowhere
      // to go.
      title={label}
      onClick={onUnsplit}
      className={cn(
        PINNED,
        PINNED_RIGHT,
        "mb-0.5 size-7 text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
    </Button>
  );
}
