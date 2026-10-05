"use client";

import { useQuery } from "@tanstack/react-query";
import { HostApprovingDevicesPanel } from "@/components/hosts/host-approving-devices-panel";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ed25519PublicKeyFingerprint } from "@/lib/signed-signal";
import { CockpitSection, Fact } from "./cockpit-section";
import { useHostCockpit } from "./host-cockpit";

/**
 * Who this host lets in: the devices that approved it, and the identity this
 * browser holds it to. Approving and removing devices is the account's
 * business — "Manage devices" opens Settings → Access, where the phone's
 * opens Browser devices.
 */
export function HostAccess() {
  const { hostId, host, hostQuery } = useHostCockpit();
  // Displayed fingerprint, derived LOCALLY from the served key (mesh B5): the
  // server no longer serves one, and this page would not show it if it did.
  const fingerprintQ = useQuery({
    queryKey: ["host-key-fingerprint", host?.host_public_key ?? null],
    queryFn: () => ed25519PublicKeyFingerprint(host?.host_public_key as string),
    enabled: Boolean(host?.host_public_key),
    staleTime: Number.POSITIVE_INFINITY,
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4 @md/shell:p-6">
        {hostQuery.isLoading && <Skeleton className="h-24 w-full rounded-xl" />}
        {host && (
          <CockpitSection
            id="host-identity"
            title="Identity"
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => openSettings("access")}
              >
                Manage devices
              </Button>
            }
          >
            <dl className="grid grid-cols-1 gap-x-6 gap-y-4 p-4 text-sm @lg/shell:grid-cols-2">
              <Fact label="Host identity" value={host.host_key_algorithm ?? "legacy unpaired"} />
              <Fact
                label="Fingerprint"
                value={host.host_public_key ? (fingerprintQ.data ?? "…") : "not pinned"}
                mono
              />
            </dl>
          </CockpitSection>
        )}
        <HostApprovingDevicesPanel hostId={hostId} />
      </div>
    </div>
  );
}
