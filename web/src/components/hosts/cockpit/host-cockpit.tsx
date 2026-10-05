"use client";

import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, Unplug } from "lucide-react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useHostOffers } from "@/components/hosts/use-host-offers";
import { HostUpdateDialog, useHostUpdate } from "@/components/release/HostUpdateDialog";
import { confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { type RouteTab, RouteTabs } from "@/components/ui/tabs";
import { ApiError, type Host, hosts } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  BrowserHostPinError,
  browserHostPinServerOrigin,
  loadBrowserHostPin,
  resolveActiveBrowserHostPin,
  revokeBrowserHostPin,
} from "@/lib/browser-host-pins";
import { HOST_TABS, hostTabHref, hostTabSegment } from "@/lib/host-cockpit";
import { HOST_IDENTITY_BLOCKED_REASON } from "@/lib/signed-rtc-trust";
import { ed25519PublicKeyFingerprint } from "@/lib/signed-signal";
import { CockpitHeader } from "./cockpit-header";
import { HostIdentityConflict } from "./host-identity-conflict";

class HostDeletionFlowError extends Error {
  constructor(
    message: string,
    readonly localTombstoneWritten: boolean,
  ) {
    super(message);
    this.name = "HostDeletionFlowError";
  }
}

interface HostCockpitValue {
  hostId: string;
  hostQuery: UseQueryResult<Host>;
  host: Host | undefined;
  /** The served key is not the one this browser approved: every connection
   *  to the host stays shut until it is removed and possessed again. */
  identityBlocked: boolean;
  /** Opens the "Update SPAWN D" dialog for this host. */
  openHostUpdate: () => void;
}

const HostCockpitContext = createContext<HostCockpitValue | null>(null);

/** The host the page is about, for the section rendered inside it. */
export function useHostCockpit(): HostCockpitValue {
  const value = useContext(HostCockpitContext);
  if (!value) throw new Error("useHostCockpit is only available inside a host's page.");
  return value;
}

/**
 * A host's page: the frame every section of it shares — the header (name,
 * the other hosts, how this device reaches it, "New window here…", ⋯), the
 * identity panel when the host's key changed, and the row of sections, each
 * its own address. The frame stays mounted as you move between sections, so
 * the header's status and the host's connection do not flicker.
 *
 * Rename, update and remove live here because they are the host's, not a
 * section's; the local trust bookkeeping that removal depends on lives here
 * with them.
 */
export function HostCockpit({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [localDeletionPending, setLocalDeletionPending] = useState(false);
  const [identityConflict, setIdentityConflict] = useState(false);

  const hostQ = useQuery({
    queryKey: ["host", id],
    queryFn: () => hosts.get(id as string),
    enabled: Boolean(id),
    refetchInterval: 30_000,
  });
  const host = hostQ.data;
  const hostUpdate = useHostUpdate(host ?? null, { autoOpen: true });
  const offers = useHostOffers(id ?? null);

  const renameM = useMutation({
    mutationFn: (name: string) => hosts.rename(id as string, name),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["host", id] });
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
    },
    onError: (caught) => setError(caught instanceof ApiError ? caught.message : String(caught)),
  });
  const removeM = useMutation({
    mutationFn: async () => {
      if (!host || !user) {
        throw new HostDeletionFlowError(
          "Authenticated host identity is unavailable; deletion was blocked",
          false,
        );
      }
      const targetHostId = id as string;
      if (host.id !== targetHostId) {
        throw new HostDeletionFlowError(
          "Host API response ID does not exactly match the route and DELETE target",
          false,
        );
      }
      let localTombstoneWritten = false;
      try {
        // Revoking the local pin is best-effort cleanup and must never block the
        // server delete. There is nothing active to revoke when the host has no
        // key (never pinnable — legacy/orphaned), no local pin is bound in this
        // browser (missing_pin), or the pin is already a tombstone. In all those
        // cases proceed straight to the server delete instead of failing "before
        // any server DELETE"; only a genuine local-storage fault still blocks.
        if (host.host_public_key) {
          try {
            await revokeBrowserHostPin({
              accountId: user.id,
              origin: browserHostPinServerOrigin(),
              targetHostId,
              claimedHostId: host.id,
              claimedHostPublicKey: host.host_public_key,
            });
            localTombstoneWritten = true;
          } catch (caught) {
            const nothingToRevoke =
              caught instanceof BrowserHostPinError &&
              ["revoked_pin", "missing_pin", "null_key"].includes(caught.code);
            if (!nothingToRevoke) throw caught;
          }
        }
        setLocalDeletionPending(true);
        await hosts.remove(targetHostId);
      } catch (caught) {
        throw new HostDeletionFlowError(
          caught instanceof Error ? caught.message : String(caught),
          localTombstoneWritten,
        );
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      // The host is gone; the Hosts page it left is the place to land.
      router.push("/hosts");
    },
    onError: (caught) => {
      if (caught instanceof HostDeletionFlowError && caught.localTombstoneWritten) {
        setLocalDeletionPending(true);
        setError(
          `Local host trust is revoked, but server deletion did not complete: ${caught.message}. Retry server deletion; the local tombstone will remain.`,
        );
        return;
      }
      setError(
        `Host deletion was blocked before any server DELETE: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    },
  });

  useEffect(() => {
    const hostPublicKey = host?.host_public_key;
    if (!host || !user || !id || !hostPublicKey) return;
    let cancelled = false;
    void (async () => {
      try {
        if (host.id !== id) {
          throw new Error("Host API response ID does not exactly match this route");
        }
        // Locally derived (mesh B5) — the pin store never sees a served label.
        const hostFingerprint = await ed25519PublicKeyFingerprint(hostPublicKey);
        try {
          await resolveActiveBrowserHostPin({
            accountId: user.id,
            origin: browserHostPinServerOrigin(),
            hostId: id,
            claimedHostPublicKey: hostPublicKey,
          });
          if (!cancelled) setIdentityConflict(false);
        } catch (caught) {
          // The served key is not the one this browser approved for this Host
          // ID: reinstall/re-key or substitution. Show the guided panel (with
          // the safe exit) instead of a generic storage error.
          if (caught instanceof BrowserHostPinError && caught.code === "host_id_key_conflict") {
            if (!cancelled) {
              setIdentityConflict(true);
              setLocalDeletionPending(false);
            }
            return;
          }
          // An already-bound tombstone is expected after a failed server
          // DELETE. Confirm its exact binding below without reactivating it.
          if (!(caught instanceof BrowserHostPinError) || caught.code !== "revoked_pin") {
            throw caught;
          }
        }
        const pin = await loadBrowserHostPin({
          accountId: user.id,
          origin: browserHostPinServerOrigin(),
          hostPublicKey,
          hostFingerprint,
        });
        if (pin === null || !pin.hostIds.includes(id)) {
          throw new Error("No exact local Host-ID-to-key binding exists for this route");
        }
        if (!cancelled) setLocalDeletionPending(pin.state === "revoked");
      } catch (caught) {
        if (!cancelled) {
          setLocalDeletionPending(false);
          setError(
            `Local host trust status is unavailable: ${caught instanceof Error ? caught.message : String(caught)}`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, id, user]);

  const requestRemove = async () => {
    if (!host) return;
    const accepted = await confirm({
      title: `Remove ${host.name}?`,
      body: "Its daemon token is revoked and SPAWN D stops connecting to it. Sessions already running there may keep running on that host.",
      confirmLabel: localDeletionPending ? "Retry deletion" : "Remove host",
      destructive: true,
    });
    if (accepted) removeM.mutate();
  };

  if (!id) return null;

  const segment = hostTabSegment(pathname, id);
  const tabs: RouteTab[] = [
    ...HOST_TABS.filter((tab) => tab.id !== "access"),
    ...offers.tabs.map((slot) => ({ id: slot.id, label: slot.label, segment: slot.segment ?? "" })),
    ...HOST_TABS.filter((tab) => tab.id === "access"),
  ].map((tab) => ({
    key: tab.segment || "overview",
    label: tab.label,
    href: hostTabHref(id, tab.segment),
    // The file browser would only meet the same refusal, so its way in is
    // shut and says why — as the phone's Files tab does.
    disabledReason:
      identityConflict && tab.segment === "files" ? HOST_IDENTITY_BLOCKED_REASON : null,
  }));

  return (
    <HostCockpitContext.Provider
      value={{
        hostId: id,
        hostQuery: hostQ,
        host,
        identityBlocked: identityConflict,
        openHostUpdate: () => host && hostUpdate.openHostUpdate(host),
      }}
    >
      {/* The page is a fixed frame, like a workspace: the header and the
          section row stay put and each section scrolls inside it — the file
          browser needs a bounded height to lay itself out. */}
      <div className="flex h-[calc(var(--vv-height)-3rem)] min-h-0 flex-col @md/shell:h-[calc(var(--vv-height)-2*var(--content-inset))]">
        <CockpitHeader
          hostId={id}
          host={host}
          segment={segment}
          identityBlocked={identityConflict}
          renaming={renameM.isPending}
          onRename={async (name) => {
            await renameM.mutateAsync(name);
          }}
          onUpdate={() => host && hostUpdate.openHostUpdate(host)}
          onRemove={() => void requestRemove()}
          removeLabel={localDeletionPending ? "Retry server deletion" : "Remove host"}
        />
        <RouteTabs
          label={`${host?.name ?? "Host"} sections`}
          tabs={tabs}
          current={segment || "overview"}
        />
        <div className="flex min-h-0 flex-1 flex-col bg-background">
          {(error || identityConflict || localDeletionPending || hostQ.error) && (
            <div className="mx-auto w-full max-w-5xl shrink-0 space-y-3 px-4 pt-4 @md/shell:px-6">
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              {identityConflict && (
                <HostIdentityConflict
                  removing={removeM.isPending}
                  onRemove={() => void requestRemove()}
                />
              )}
              {localDeletionPending && (
                <p className="text-sm text-foreground" role="status">
                  This browser retains a revoked host/key tombstone. Server deletion is retryable
                  and server disappearance will not clear local trust state.
                </p>
              )}
              {hostQ.error && (
                <p className="text-sm text-destructive" role="alert">
                  Failed to load host: {String(hostQ.error)}
                </p>
              )}
            </div>
          )}
          {identityConflict && segment === "files" ? (
            <EmptyState
              icon={<ShieldAlert />}
              title="Files are blocked"
              body={HOST_IDENTITY_BLOCKED_REASON}
            />
          ) : host && host.status !== "online" && segment === "files" ? (
            // The browser reads the host over this device's own connection to
            // it; with the host away there is nothing it could list.
            <EmptyState
              icon={<Unplug />}
              title={`${host.name} is offline`}
              body="File browsing needs a live, direct connection to this host."
            />
          ) : (
            children
          )}
        </div>
      </div>
      <HostUpdateDialog {...hostUpdate.dialogProps} />
    </HostCockpitContext.Provider>
  );
}
