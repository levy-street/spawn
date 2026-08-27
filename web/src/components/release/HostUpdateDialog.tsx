"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, type Host, hosts } from "@/lib/api";
import { installCommandForHostOS } from "@/lib/host-platform";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 2_000;
const POLL_LIMIT_MS = 3 * 60_000;
const AUTO_OPEN_KEY_PREFIX = "spawn.hostUpdate.seen.";
const ACTION_STATES = new Set(["available", "updating", "failed", "unsupported"]);
const AUTO_OPEN_STATES = new Set(["available", "failed", "unsupported"]);
const autoOpenedHosts = new Set<string>();

export function HostUpdateBadge({ host, className }: { host: Host; className?: string }) {
  if (host.update.state === "available") {
    return (
      <Badge variant="warning" className={className}>
        update available
      </Badge>
    );
  }
  if (host.update.state === "updating") {
    return (
      <Badge variant="info" className={className}>
        updating
      </Badge>
    );
  }
  return null;
}

export interface HostUpdateDialogProps {
  host: Host | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The available-state escape hatch. A guarded launch uses it to continue. */
  onNotNow?: () => void;
  /** A guarded launch resumes automatically once polling observes current. */
  onCurrent?: () => void;
}

/** State and action gating shared by host detail and every launch picker. */
export function useHostUpdate(host: Host | null, options: { autoOpen?: boolean } = {}) {
  const [activeHost, setActiveHost] = useState<Host | null>(host);
  const [open, setOpen] = useState(false);
  const pendingAction = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!host) return;
    setActiveHost((current) => (current?.id === host.id || !open ? host : current));
  }, [host, open]);

  useEffect(() => {
    if (!options.autoOpen || !host || !AUTO_OPEN_STATES.has(host.update.state)) return;
    if (autoOpenedHosts.has(host.id)) return;
    const key = `${AUTO_OPEN_KEY_PREFIX}${host.id}`;
    try {
      if (window.sessionStorage.getItem(key) === "true") return;
      window.sessionStorage.setItem(key, "true");
    } catch {
      // Storage denial should not suppress a useful update prompt.
    }
    autoOpenedHosts.add(host.id);
    setActiveHost(host);
    setOpen(true);
  }, [host, options.autoOpen]);

  const settle = useCallback((proceed: boolean) => {
    const action = pendingAction.current;
    pendingAction.current = null;
    setOpen(false);
    if (proceed) action?.();
  }, []);

  const promptHostUpdate = useCallback((target: Host, afterDismiss: () => void) => {
    if (!ACTION_STATES.has(target.update.state)) {
      afterDismiss();
      return false;
    }
    pendingAction.current = afterDismiss;
    setActiveHost(target);
    setOpen(true);
    return true;
  }, []);

  const openHostUpdate = useCallback((target?: Host) => {
    pendingAction.current = null;
    if (target) setActiveHost(target);
    setOpen(true);
  }, []);

  return {
    open,
    activeHost,
    openHostUpdate,
    promptHostUpdate,
    dialogProps: {
      host: activeHost,
      open,
      onOpenChange: (next: boolean) => {
        if (next) setOpen(true);
        else settle(pendingAction.current !== null);
      },
      onNotNow: () => settle(true),
      onCurrent: () => settle(true),
    } satisfies HostUpdateDialogProps,
  };
}

export function HostUpdateDialog({
  host,
  open,
  onOpenChange,
  onNotNow,
  onCurrent,
}: HostUpdateDialogProps) {
  const queryClient = useQueryClient();
  const [pollStartedAt, setPollStartedAt] = useState<number | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const completed = useRef<string | null>(null);

  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => {
    setRequestError(null);
    completed.current = null;
    if (!host?.id || !open || host.update.state !== "updating") {
      setPollStartedAt(null);
      return;
    }
    const requested = Date.parse(host.update.requested_at ?? "");
    setPollStartedAt(Number.isFinite(requested) ? requested : Date.now());
  }, [host?.id, host?.update.requested_at, host?.update.state, open]);

  const hostQ = useQuery({
    queryKey: ["host", host?.id],
    queryFn: () => hosts.get(host!.id),
    enabled: open && host !== null,
    staleTime: 0,
    refetchInterval: (query) => {
      const observed = (query.state.data as Host | undefined) ?? host;
      if (!open || observed?.update.state !== "updating" || pollStartedAt === null) return false;
      return Date.now() - pollStartedAt < POLL_LIMIT_MS ? POLL_INTERVAL_MS : false;
    },
  });
  const currentHost = hostQ.data ?? host;

  const updateM = useMutation({
    mutationFn: () => hosts.update(currentHost!.id),
    onSuccess: ({ update }) => {
      setRequestError(null);
      setPollStartedAt(Date.now());
      queryClient.setQueryData<Host>(["host", currentHost!.id], (cached) =>
        cached ? { ...cached, update } : currentHost ? { ...currentHost, update } : cached,
      );
      queryClient.setQueryData<Host[]>(["hosts"], (cached) =>
        cached?.map((item) => (item.id === currentHost!.id ? { ...item, update } : item)),
      );
    },
    onError: (caught) => {
      setRequestError(caught instanceof ApiError ? caught.message : String(caught));
      void queryClient.invalidateQueries({ queryKey: ["host", currentHost?.id] });
      void queryClient.invalidateQueries({ queryKey: ["hosts"] });
    },
  });

  useEffect(() => {
    if (!currentHost) return;
    const state = currentHost.update.state;
    if (state !== "current" && state !== "failed") return;
    if (state === "failed" && pollStartedAt === null) return;
    const completion = `${currentHost.id}:${state}:${currentHost.update.requested_at ?? ""}`;
    if (completed.current === completion) return;
    completed.current = completion;
    void queryClient.invalidateQueries({ queryKey: ["hosts"] });
    void queryClient.invalidateQueries({ queryKey: ["host", currentHost.id] });
    if (state === "current") onCurrent?.();
  }, [currentHost, onCurrent, pollStartedAt, queryClient]);

  if (!currentHost || currentHost.update.state === "current" || !open) return null;

  const state = currentHost.update.state;
  const installCommand = installCommandForHostOS(currentHost.os, origin);
  const close = () => onOpenChange(false);
  const retry = () => updateM.mutate();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" hideClose={state !== "updating"}>
        <DialogHeader>
          <DialogTitle>Update SPAWN D on {currentHost.name}</DialogTitle>
          {state === "available" && currentHost.status === "offline" ? (
            <DialogDescription>
              This machine is offline. It updates itself the next time it connects.
            </DialogDescription>
          ) : state === "available" ? (
            <DialogDescription>
              This machine is running an older SPAWN D daemon ({currentHost.version ?? "unknown"}).
              Update it to keep working with this version of the app. Running sessions are kept.
            </DialogDescription>
          ) : state === "updating" ? (
            <DialogDescription asChild>
              <div className="flex items-start gap-2.5 pt-1">
                <Spinner className="mt-0.5 shrink-0" label="Updating SPAWN D" />
                <p>Updating… the daemon restarts itself; sessions keep running.</p>
              </div>
            </DialogDescription>
          ) : state === "failed" ? (
            <DialogDescription asChild>
              <div>
                <InstallFallback
                  message={`The update did not complete: ${currentHost.update.error ?? "unknown error"}. Run this on the machine:`}
                  command={installCommand}
                  copyDisabled={!origin}
                />
              </div>
            </DialogDescription>
          ) : state === "unsupported" ? (
            <DialogDescription asChild>
              <div>
                <InstallFallback
                  message={`This daemon cannot update itself (${currentHost.update.error ?? "unknown reason"}). Run this on the machine:`}
                  command={installCommand}
                  copyDisabled={!origin}
                />
              </div>
            </DialogDescription>
          ) : (
            <DialogDescription>Update status is not available for this machine.</DialogDescription>
          )}
          {requestError && (
            <p className="pt-2 text-xs text-destructive" role="alert">
              {requestError}
            </p>
          )}
        </DialogHeader>

        {state === "available" && currentHost.status === "offline" ? (
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={close}>
              Close
            </Button>
          </DialogFooter>
        ) : state === "available" ? (
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onNotNow ?? close}>
              Not now
            </Button>
            <Button type="button" size="sm" disabled={updateM.isPending} onClick={retry}>
              {updateM.isPending ? <Spinner size={14} label="Requesting update" /> : null}
              Update now
            </Button>
          </DialogFooter>
        ) : state === "failed" ? (
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={close}>
              Close
            </Button>
            <Button type="button" size="sm" disabled={updateM.isPending} onClick={retry}>
              {updateM.isPending ? <Spinner size={14} label="Requesting update" /> : null}
              Try again
            </Button>
          </DialogFooter>
        ) : state === "unsupported" || state === "unknown" ? (
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={close}>
              Close
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function InstallFallback({
  message,
  command,
  copyDisabled,
}: {
  message: string;
  command: string;
  copyDisabled: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 pt-1 text-sm text-muted-foreground">
      <p>{message}</p>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-2">
        <code className="min-w-0 flex-1 break-all text-xs text-foreground">{command}</code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("h-8 shrink-0", copied && "text-success")}
          disabled={copyDisabled}
          onClick={() => void copy()}
        >
          Copy
        </Button>
      </div>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied install command" : ""}
      </span>
    </div>
  );
}
