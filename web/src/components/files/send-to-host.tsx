"use client";

import { useQuery } from "@tanstack/react-query";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTransfers } from "@/components/files/transfers-provider";
import { HostUpdateBadge } from "@/components/release/HostUpdateDialog";
import { Button } from "@/components/ui/button";
import { CascadeMenu, type CascadeMenuHandle } from "@/components/ui/cascade-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { hostStatusTone, StatusDot } from "@/components/ui/status";
import { Tabs } from "@/components/ui/tabs";
import { FolderPicker } from "@/components/workspace/folder-picker";
import { useHostControl } from "@/hooks/useHostControl";
import { type Host, hosts } from "@/lib/api";
import {
  CHANGE_FOLDER_LABEL,
  CONFLICT_POLICY_COPY,
  CONFLICT_POLICY_LABEL,
  PERMISSIONS_NOT_COPIED,
  SEND_HOST_OFFLINE,
  SEND_NO_OTHER_HOST,
  SEND_PICK_HOST_TITLE,
  sendDestinationLine,
  sendFolderTitle,
  sendTitle,
} from "@/lib/files/copy";
import { CONFLICT_POLICIES, type ConflictPolicy, type WalkSource } from "@/lib/files/transfer-plan";
import {
  basename,
  isPathWithin,
  joinPath,
  normalizeAbsolutePath,
  pathFlavorForHostOS,
  pathsEqual,
  trimTrailingSlash,
} from "@/lib/paths";
import { displayPath } from "@/lib/places";

/**
 * "Send to another host…": which host, which folder there, and what to do
 * about a name already taken — then the send runs in the Transfers tray.
 *
 * The same three steps every "where" in the app takes: a cascade of hosts, the
 * folder browser on the one picked (opening at the same folder relative to
 * home when it exists there, else at home), and a short confirmation that
 * carries the conflict policy. The bytes go from one host to this device to
 * the other, checked end to end; the hosts never connect to each other.
 */

export interface SendToHostHandle {
  /** Start the flow for `items`, the cascade hanging off a point (a menu's) or the browser's centre. */
  open(items: WalkSource[], at?: { x: number; y: number }): void;
}

interface SendToHostProps {
  sourceHostId: string;
  /** The source's home and the folder the items are in, for "the same folder there". */
  sourceHome: string | null;
  sourceDir: string | null;
  sourceOs: string | null | undefined;
}

/** How long to wait for the other host before opening its browser at home instead. */
const SAME_FOLDER_PROBE_MS = 2_500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export const SendToHost = forwardRef<SendToHostHandle, SendToHostProps>(function SendToHost(
  { sourceHostId, sourceHome, sourceDir, sourceOs },
  ref,
) {
  const transfers = useTransfers();
  const menuRef = useRef<CascadeMenuHandle>(null);
  const [items, setItems] = useState<WalkSource[]>([]);
  const [target, setTarget] = useState<Host | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerStart, setPickerStart] = useState<string | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  /** Set the moment the browser picks a folder, before its own close arrives. */
  const chosen = useRef<string | null>(null);
  const [policy, setPolicy] = useState<ConflictPolicy>("ask");
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, staleTime: 30_000 });
  const others = (hostsQ.data ?? []).filter((host) => host.id !== sourceHostId);
  // The destination's own connection, for its home folder and "the same folder there".
  const { client, state } = useHostControl(target?.id ?? null, target !== null);
  const targetFlavor = pathFlavorForHostOS(target?.os);
  const homeQ = useQuery({
    queryKey: ["host-home", target?.id],
    queryFn: () => client!.home(),
    enabled: state === "ready" && client !== null && target !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
  });
  const targetHome = homeQ.data?.home_dir
    ? trimTrailingSlash(normalizeAbsolutePath(homeQ.data.home_dir, targetFlavor), targetFlavor)
    : null;

  useImperativeHandle(
    ref,
    () => ({
      open: (picked, at) => {
        if (picked.length === 0) return;
        setItems(picked);
        setTarget(null);
        setDestination(null);
        setPolicy("ask");
        if (at) menuRef.current?.openAt(at.x, at.y);
        else menuRef.current?.open();
      },
    }),
    [],
  );

  /** Where the folder browser opens on `host`: the same folder relative to home, when it is there. */
  const sameFolderThere = useCallback(
    async (host: Host): Promise<string | null> => {
      const sourceFlavor = pathFlavorForHostOS(sourceOs);
      if (!sourceHome || !sourceDir || !isPathWithin(sourceDir, sourceHome, sourceFlavor))
        return null;
      if (pathsEqual(sourceDir, sourceHome, sourceFlavor)) return null;
      const relative = sourceDir
        .slice(trimTrailingSlash(sourceHome, sourceFlavor).length)
        .split(/[\\/]/u)
        .filter(Boolean)
        .join("/");
      if (!client || state !== "ready" || !client.hasCapability("fs.stat")) return null;
      const home = await withTimeout(client.home(), SAME_FOLDER_PROBE_MS);
      if (!home) return null;
      const flavor = pathFlavorForHostOS(host.os);
      const candidate = joinPath(home.home_dir, relative, flavor);
      const stat = await withTimeout(client.stat(candidate), SAME_FOLDER_PROBE_MS);
      return stat?.kind === "directory" ? candidate : null;
    },
    [client, sourceDir, sourceHome, sourceOs, state],
  );

  /** A host picked, its folder browser not open yet: it opens where it should once the host answers. */
  const [locating, setLocating] = useState(false);
  const chooseHost = (host: Host) => {
    chosen.current = null;
    setTarget(host);
    setPickerStart(null);
    setLocating(true);
  };

  useEffect(() => {
    if (!locating || !target) return;
    let settled = false;
    const openAt = (path: string | null) => {
      if (settled) return;
      settled = true;
      setPickerStart(path);
      setLocating(false);
      setPickerOpen(true);
    };
    // A host slow to answer gets its browser at home rather than a wait.
    const fallback = setTimeout(() => openAt(null), SAME_FOLDER_PROBE_MS * 2);
    if (state === "ready") void sameFolderThere(target).then(openAt);
    return () => {
      settled = true;
      clearTimeout(fallback);
    };
  }, [locating, sameFolderThere, state, target]);

  const names = items.map((item) => item.name);
  const sendLabel = target ? sendTitle(names, target.name) : "";
  const destLabel =
    destination && targetHome && pathsEqual(destination, targetHome, targetFlavor)
      ? "Home"
      : destination
        ? basename(destination, targetFlavor) || destination
        : "";
  const confirmOpen = target !== null && destination !== null && !pickerOpen;

  const send = () => {
    if (!transfers || !target || !destination) return;
    transfers.send({
      from: sourceHostId,
      to: target.id,
      sources: items,
      destDir: destination,
      destLabel,
      policy,
    });
    setTarget(null);
    setDestination(null);
  };

  return (
    <>
      <CascadeMenu
        ref={menuRef}
        root={{
          id: "send-to-host",
          title: SEND_PICK_HOST_TITLE,
          loading: hostsQ.isLoading,
          emptyLabel: SEND_NO_OTHER_HOST,
          items: others.map((host) => ({
            key: host.id,
            icon: <StatusDot tone={hostStatusTone(host.status)} label={host.status} />,
            label: host.name,
            detail: host.status === "online" ? undefined : SEND_HOST_OFFLINE,
            trailing: <HostUpdateBadge host={host} />,
            disabled: host.status !== "online",
            onSelect: () => chooseHost(host),
          })),
        }}
        sheetTitle={SEND_PICK_HOST_TITLE}
        // Opened from the browser's own menus, at their point: no trigger of its own.
        renderTrigger={() => (
          <span aria-hidden className="pointer-events-none absolute size-0 overflow-hidden" />
        )}
      />
      <FolderPicker
        key={`${target?.id ?? "none"}:${pickerOpen ? "open" : "closed"}:${pickerStart ?? "~"}`}
        open={pickerOpen && target !== null}
        host={target}
        initialPath={pickerStart ?? "~"}
        title={target ? sendFolderTitle(target.name) : undefined}
        selectUnchanged
        onBack={() => {
          setPickerOpen(false);
          setTarget(null);
          menuRef.current?.open();
        }}
        onOpenChange={(open) => {
          setPickerOpen(open);
          // Closed without a folder: the send is off.
          if (!open && chosen.current === null) setTarget(null);
        }}
        onSelect={(path) => {
          chosen.current = path;
          setDestination(path);
          setPickerOpen(false);
        }}
      />
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) {
            setTarget(null);
            setDestination(null);
          }
        }}
      >
        <DialogContent size="sm">
          {target && destination && (
            <>
              <DialogHeader>
                <DialogTitle className="break-words">{sendLabel}</DialogTitle>
                <DialogDescription className="break-words text-xs">
                  <span title={displayPath(destination)}>
                    {sendDestinationLine(destLabel, target.name)}
                  </span>{" "}
                  <button
                    type="button"
                    className="font-medium text-foreground underline underline-offset-2"
                    onClick={() => {
                      chosen.current = null;
                      setPickerStart(destination);
                      setDestination(null);
                      setPickerOpen(true);
                    }}
                  >
                    {CHANGE_FOLDER_LABEL}
                  </button>
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2 px-4 pb-2">
                <p className="text-xs font-medium text-foreground">{CONFLICT_POLICY_LABEL}</p>
                <Tabs
                  label={CONFLICT_POLICY_LABEL}
                  items={CONFLICT_POLICIES.map((value) => ({
                    value,
                    label: CONFLICT_POLICY_COPY[value].label,
                  }))}
                  value={policy}
                  onValueChange={setPolicy}
                />
                <p className="text-xs text-muted-foreground">
                  {CONFLICT_POLICY_COPY[policy].detail}
                </p>
                <p className="text-xs text-muted-foreground">{PERMISSIONS_NOT_COPIED}</p>
              </div>
              {/* The send button says the whole sentence, which a long name or
                host can make wider than the dialog. It gives way, cut short
                with the title above saying it in full, and Cancel never does. */}
              <DialogFooter>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    setTarget(null);
                    setDestination(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="min-w-0"
                  title={sendLabel}
                  onClick={send}
                  disabled={!transfers}
                >
                  <span className="truncate">{sendLabel}</span>
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
});
