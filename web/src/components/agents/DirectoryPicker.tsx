"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronUp, Folder, Home, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHostControl } from "@/hooks/useHostControl";
import type { Host } from "@/lib/api";
import {
  normalizeCwdForHost,
  parentDir,
  splitForDirectorySuggestions,
  withTrailingSlash,
} from "@/lib/paths";

export function DirectoryPicker({
  host,
  value,
  onChange,
  disabled,
}: {
  host: Host | undefined;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { client, state } = useHostControl(host?.id ?? null, host?.status === "online");
  const homeQ = useQuery({
    queryKey: ["host-home", host?.id],
    queryFn: () => client!.home(),
    enabled: state === "ready" && client !== null,
  });
  const homeDir = homeQ.data?.home_dir.trim() || "~";
  const resolved = normalizeCwdForHost(value, homeDir);
  const suggestion = splitForDirectorySuggestions(value, homeDir);
  const dirsQ = useQuery({
    queryKey: ["host-dirs", host?.id, suggestion.base],
    queryFn: () => client!.list(suggestion.base),
    enabled: state === "ready" && client !== null,
    staleTime: 5_000,
  });
  const listId = `agent-cwd-options-${host?.id ?? "none"}`;
  const entries = useMemo(() => {
    const prefix = suggestion.prefix.toLowerCase();
    return (dirsQ.data?.entries ?? []).filter(
      (entry) => entry.is_dir && entry.name.toLowerCase().startsWith(prefix),
    );
  }, [dirsQ.data?.entries, suggestion.prefix]);
  const parent = dirsQ.data?.parent ?? parentDir(resolved);
  const statusText = host
    ? host.status === "online"
      ? "Missing directories are created automatically."
      : "Host is offline."
    : "Choose a host first.";

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label htmlFor="agent-cwd">Directory</Label>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Use home directory"
            title="Use home directory"
            onClick={() => onChange(withTrailingSlash(homeDir))}
            disabled={disabled || !host}
          >
            <Home className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Parent directory"
            title="Parent directory"
            onClick={() => onChange(withTrailingSlash(parent))}
            disabled={disabled || !host}
          >
            <ChevronUp className="size-4" />
          </Button>
          <Input
            id="agent-cwd"
            list={listId}
            placeholder={homeDir}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            disabled={disabled || !host}
            className="font-mono"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Refresh directories"
            title="Refresh directories"
            onClick={() => dirsQ.refetch()}
            disabled={disabled || !host || host.status !== "online" || dirsQ.isFetching}
          >
            <RefreshCw className={`size-4 ${dirsQ.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <datalist id={listId}>
          {entries.map((entry) => (
            <option key={entry.path} value={entry.path} />
          ))}
        </datalist>
        <p className="text-xs text-muted-foreground">
          {statusText} Resolved path: <code>{resolved}</code>
        </p>
      </div>
      {host?.status === "online" && (
        <div className="rounded-lg border border-border bg-background/60">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="min-w-0 truncate font-mono">{suggestion.base}</span>
            {dirsQ.isError && <span className="shrink-0 text-destructive">Could not load</span>}
          </div>
          <div className="max-h-44 overflow-auto p-1">
            {parent && parent !== suggestion.base && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => onChange(withTrailingSlash(parent))}
                disabled={disabled}
              >
                <ChevronUp className="size-4 text-muted-foreground" />
                <span className="font-mono">..</span>
              </button>
            )}
            {entries.map((entry) => (
              <button
                type="button"
                key={entry.path}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => onChange(withTrailingSlash(entry.path))}
                disabled={disabled}
              >
                <Folder className="size-4 text-muted-foreground" />
                <span className="min-w-0 truncate font-mono">{entry.name}</span>
              </button>
            ))}
            {!dirsQ.isFetching && entries.length === 0 && (
              <div className="px-2 py-2 text-sm text-muted-foreground">
                {dirsQ.isError ? "No existing directory at this path." : "No matching folders."}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
