"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Folder } from "lucide-react";
import { DropdownMenu, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import type { HostControlClient } from "@/lib/hostControl";
import { listAllEntries, visibleDirectories } from "./folder-picker-helpers";

type DrillProps = {
  hostId: string | null;
  client: HostControlClient | null;
  dirPath: string;
  activeChild: string | null;
  showHidden: boolean;
  onNavigate: (path: string) => void;
};

/**
 * The chevron after each breadcrumb: opens that crumb's subfolders so you can
 * jump across the trail without walking back down through the columns.
 */
export function CrumbDrillMenu({ dirPath, client, ...rest }: DrillProps) {
  return (
    <DropdownMenu
      align="start"
      className="shrink-0"
      menuClassName="max-h-72 min-w-52 max-w-72"
      renderTrigger={(props) => (
        <button
          {...props}
          type="button"
          disabled={!client}
          aria-label={`Browse ${dirPath}`}
          className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none"
        >
          <ChevronRight className="size-3" aria-hidden />
        </button>
      )}
    >
      <CrumbDrillItems dirPath={dirPath} client={client} {...rest} />
    </DropdownMenu>
  );
}

/** Only mounted while the menu is open, so the listing is fetched on demand. */
function CrumbDrillItems({
  hostId,
  client,
  dirPath,
  activeChild,
  showHidden,
  onNavigate,
}: DrillProps) {
  const foldersQ = useQuery({
    queryKey: ["host-folders", hostId, dirPath],
    queryFn: () => listAllEntries((cursor) => client!.listPage(dirPath, cursor)),
    enabled: client !== null,
    staleTime: 5_000,
  });
  const folders = visibleDirectories(foldersQ.data?.entries, { showHidden });

  if (foldersQ.isPending) {
    return (
      <div className="flex h-9 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (foldersQ.isError) {
    return <p className="px-2 py-1.5 text-xs text-destructive">Could not list this folder.</p>;
  }
  if (folders.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No subfolders</p>;
  }
  return (
    <>
      {folders.map((entry) => (
        <DropdownMenuItem key={entry.path} onSelect={() => onNavigate(entry.path)}>
          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {entry.path === activeChild && <Check className="size-3.5 shrink-0" aria-hidden />}
        </DropdownMenuItem>
      ))}
    </>
  );
}
