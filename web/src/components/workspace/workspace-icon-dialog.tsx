"use client";

import { useQuery } from "@tanstack/react-query";
import { ImageOff, RefreshCw, Type, Upload } from "lucide-react";
import { type ChangeEvent, useRef, useState } from "react";
import { WorkspaceAvatar } from "@/components/nav/sidebar-parts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { useHostControl } from "@/hooks/useHostControl";
import { hosts } from "@/lib/api";
import { basename } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { renderWorkspaceIconFromFile } from "@/lib/workspace-icon-image";
import { suggestFolderIcons } from "@/lib/workspace-icon-scan";

/** What a file input will offer, which is wider than what the folder scan
 *  ranks: whatever this browser can decode is fair game for a deliberate
 *  choice. The render is the real gate. */
const IMAGE_ACCEPT = "image/*";

/**
 * Choosing a workspace's mark.
 *
 * Three ways to answer the same question, in the order they are most likely
 * to be the right one: what the folder already contains, an image from this
 * device, or nothing at all — the initials the sidebar drew before any of
 * this existed. Picking applies immediately and closes; the dialog holds no
 * draft, so there is nothing to lose by dismissing it.
 *
 * The suggestions come from the host over the same control channel the folder
 * picker uses, and they arrive already rendered, so choosing one is a click
 * and not another round trip. A workspace with no folder, or whose host is
 * offline, simply does not get that section — the other two still work.
 */
export function WorkspaceIconDialog({
  open,
  onOpenChange,
  name,
  icon,
  hostId,
  cwd,
  busy = false,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whose mark this is — the preview needs it to draw the initials. */
  name: string;
  icon: string | null;
  /** The folder to look in, and the host it is on. Either being null drops
   *  the suggestions and leaves the manual choices. */
  hostId: string | null;
  cwd: string | null;
  busy?: boolean;
  onSelect: (icon: string | null) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const hostsQ = useQuery({
    queryKey: ["hosts"],
    queryFn: hosts.list,
    staleTime: 30_000,
    enabled: open && hostId !== null,
  });
  const host = hostsQ.data?.find((candidate) => candidate.id === hostId) ?? null;
  const canScan = open && host?.status === "online" && cwd !== null;
  const { client, state } = useHostControl(hostId, canScan);

  const suggestionsQ = useQuery({
    queryKey: ["workspace-icon-suggestions", hostId, cwd],
    queryFn: () => suggestFolderIcons(client as NonNullable<typeof client>, cwd as string),
    enabled: canScan && state === "ready" && client !== null,
    // The folder's images do not change while a dialog is open, and re-reading
    // half a dozen files to redraw the same grid is not worth a round trip.
    staleTime: 5 * 60_000,
    retry: false,
  });
  const suggestions = suggestionsQ.data ?? [];

  const choose = (next: string | null) => {
    setError(null);
    onSelect(next);
    onOpenChange(false);
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // The same file picked twice in a row is not a change event unless the
    // input forgets the first one.
    event.target.value = "";
    if (!file) return;
    setError(null);
    setReading(true);
    try {
      const rendered = await renderWorkspaceIconFromFile(file);
      if (!rendered) {
        setError("That file could not be read as an image.");
        return;
      }
      choose(rendered);
    } finally {
      setReading(false);
    }
  };

  const scanning = canScan && (state !== "ready" || suggestionsQ.isPending);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Workspace icon</DialogTitle>
          <DialogDescription>
            {cwd
              ? `Pick a mark for ${name}, or use an image from ${basename(cwd) || cwd}.`
              : `Pick a mark for ${name}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-2">
          <div className="flex items-center gap-3">
            <WorkspaceAvatar
              name={name}
              icon={icon}
              rail
              className="size-14 rounded-xl border border-border bg-muted/40 text-base"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{name}</p>
              <p className="text-xs text-muted-foreground">
                {icon ? "Wearing its own mark" : "Drawing its initials"}
              </p>
            </div>
          </div>

          {canScan && (
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">From this folder</h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={scanning}
                  onClick={() => void suggestionsQ.refetch()}
                >
                  <RefreshCw className={cn("size-3.5", scanning && "animate-spin")} aria-hidden />
                  Look again
                </Button>
              </div>
              {scanning ? (
                <div className="flex h-20 items-center justify-center rounded-lg border border-border bg-card/35">
                  <Spinner label={`Looking in ${basename(cwd ?? "") || "the folder"}`} />
                </div>
              ) : suggestions.length > 0 ? (
                <ul className="grid grid-cols-4 gap-2">
                  {suggestions.map((suggestion) => (
                    <li key={suggestion.candidate.path}>
                      <button
                        type="button"
                        disabled={busy}
                        title={
                          suggestion.candidate.dir
                            ? `${suggestion.candidate.dir}/${suggestion.candidate.name}`
                            : suggestion.candidate.name
                        }
                        onClick={() => choose(suggestion.icon)}
                        className={cn(
                          "flex w-full flex-col items-center gap-1 rounded-lg border p-2 transition-colors",
                          suggestion.icon === icon
                            ? "border-foreground/25 bg-accent"
                            : "border-border hover:bg-accent/50",
                        )}
                      >
                        {/* biome-ignore lint/performance/noImgElement: a rendered data URL held in memory, not a file to optimize */}
                        <img
                          src={suggestion.icon}
                          alt={suggestion.candidate.name}
                          className="size-8 object-contain"
                        />
                        <span className="w-full truncate text-center text-[10px] text-muted-foreground">
                          {suggestion.candidate.name}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon={<ImageOff />}
                  iconPlate={false}
                  title="Nothing here looks like an icon"
                  body="Choose an image instead, or keep the initials."
                  className="rounded-lg border border-border bg-card/35 px-4 py-6 [&>p]:text-xs"
                />
              )}
            </section>
          )}

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="border-t border-border pt-3">
          <Button
            type="button"
            variant="ghost"
            className="mr-auto"
            disabled={busy || icon === null}
            onClick={() => choose(null)}
          >
            <Type className="size-4" aria-hidden />
            Use initials
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept={IMAGE_ACCEPT}
            className="hidden"
            onChange={(event) => void chooseFile(event)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy || reading}
            onClick={() => fileRef.current?.click()}
          >
            {reading ? (
              <Spinner size={14} label="Reading image" />
            ) : (
              <Upload className="size-4" aria-hidden />
            )}
            Choose image…
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
