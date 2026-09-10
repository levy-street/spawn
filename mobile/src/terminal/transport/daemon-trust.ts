import { getBaseUrl } from "@/data/api/config";
import { openHostPinStore } from "@/data/trust/host-pins";
import { activeDeviceIdentityAccount } from "@/lib/crypto/identity";
import { HostControlTransportError } from "./host-ctl-codec";

/** Match the browser's signed first-contact policy, with local pins taking precedence. */
export async function verifyDaemonHost(hostId: string, publicKey: string): Promise<void> {
  const accountId = activeDeviceIdentityAccount();
  if (!accountId) throw new HostControlTransportError("signed_out", "You've been signed out.");
  const [store, serverUrl] = await Promise.all([openHostPinStore(), getBaseUrl()]);
  const resolution = await store.resolve({
    accountId,
    serverOrigin: new URL(serverUrl).origin,
    hostId,
    presentedHostPublicKey: publicKey,
    phoneIdentityAvailable: true,
  });
  if (activeDeviceIdentityAccount() !== accountId)
    throw new HostControlTransportError("signed_out", "You've been signed out.");
  if (resolution.status === "match" || resolution.status === "missing") return;
  throw new HostControlTransportError(
    "host_identity_unverified",
    resolution.status === "revoked"
      ? "This host's approval was revoked. Review it in Hosts."
      : resolution.status === "mismatch"
        ? "This host's identity has changed. Review it in Hosts."
        : "SPAWN D could not verify this host's saved identity. Review it in Hosts.",
  );
}
