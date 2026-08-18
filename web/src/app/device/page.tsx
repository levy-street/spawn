"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, auth, type DevicePendingApproval, hosts } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  createHostPairApprovalProof,
  loadBrowserDeviceIdentity,
} from "@/lib/browser-device-identity";
import { useBrowserDeviceRegistration } from "@/lib/browser-device-registration";
import {
  approveBrowserHostPin,
  type BrowserHostPinState,
  browserHostPinServerOrigin,
  loadBrowserHostPin,
} from "@/lib/browser-host-pins";
import { ed25519PublicKeyFingerprint } from "@/lib/signed-signal";

class ApprovalIdentityError extends Error {}

/**
 * Bind the just-approved local pin to its Host UUID so the signed-RTC
 * downgrade gate can recognize the host by ID from the very first connection
 * — an unbound pin (`hostIds: []`) is invisible to the known-host check, and
 * a hostile server could hold that host on the raw path indefinitely.
 *
 * On a re-pair the approve response already carries the UUID. On a first
 * pairing the Host row only exists after the daemon's poll completes, so
 * this retries briefly against /api/hosts, matching strictly on the exact
 * ceremony-reviewed public key (the server-supplied fingerprint is never
 * consulted). Best-effort: the key pin is already durable, and the first
 * successful key-matching resolve self-heals the binding later.
 */
async function seedApprovedHostBinding(input: {
  accountId: string;
  hostPublicKey: string;
  hostFingerprint: string;
  knownHostId: string | null | undefined;
}): Promise<void> {
  const bind = (hostId: string) =>
    approveBrowserHostPin({
      accountId: input.accountId,
      origin: browserHostPinServerOrigin(),
      hostPublicKey: input.hostPublicKey,
      hostFingerprint: input.hostFingerprint,
      hostIds: [hostId],
    });
  try {
    if (input.knownHostId) {
      await bind(input.knownHostId);
      return;
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const listed = await hosts.list().catch(() => null);
      const match = listed?.find((host) => host.host_public_key === input.hostPublicKey);
      if (match) {
        await bind(match.id);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  } catch {
    // Non-fatal by design; resolveActiveBrowserHostPin binds on first use.
  }
}

export default function DevicePage() {
  return (
    <AuthGate>
      <AppShell>
        <DeviceInner />
      </AppShell>
    </AuthGate>
  );
}

function DeviceInner() {
  const { user } = useAuth();
  const registration = useBrowserDeviceRegistration(user?.id);
  const [code, setCode] = useState("");
  const [hostName, setHostName] = useState<string | null>(null);
  const [pending, setPending] = useState<DevicePendingApproval | null>(null);
  const [localPinState, setLocalPinState] = useState<BrowserHostPinState | "new" | null>(null);
  const [localPinCommitted, setLocalPinCommitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Load the pending approval for a code and land on the fingerprint screen.
  // Extracted from the form handler so the auto-flow (code baked into the URL
  // by `spawnd possess`) can call it directly — the operator types nothing.
  const reviewCode = async (rawCode: string) => {
    const userCode = rawCode.trim().toUpperCase();
    if (!userCode) return;
    setCode(userCode);
    setError(null);
    setSubmitting(true);
    try {
      const r = await auth.pendingDevice({ user_code: userCode });
      const expectedFingerprint = await ed25519PublicKeyFingerprint(r.host_public_key);
      if (r.host_key_fingerprint !== expectedFingerprint) {
        throw new ApprovalIdentityError(
          "Daemon fingerprint did not match its public key; approval was blocked",
        );
      }
      if (!user) throw new ApprovalIdentityError("The authenticated account is unavailable");
      const existing = await loadBrowserHostPin({
        accountId: user.id,
        origin: browserHostPinServerOrigin(),
        hostPublicKey: r.host_public_key,
        hostFingerprint: expectedFingerprint,
      });
      setPending(r);
      setLocalPinState(existing?.state ?? "new");
      setLocalPinCommitted(existing?.state === "active");
    } catch (err) {
      const message =
        err instanceof ApiError || err instanceof ApprovalIdentityError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Approval failed";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const onReview = (e: FormEvent) => {
    e.preventDefault();
    void reviewCode(code);
  };

  // The daemon opens this page with the pending code baked into the URL
  // (`/device?code=…`), so an approval needs nothing typed. Auto-load it once,
  // as soon as the account is known, landing straight on the fingerprint check.
  const autoTriedRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot guarded by a ref; reviewCode intentionally omitted
  useEffect(() => {
    if (autoTriedRef.current || !user) return;
    const urlCode = new URLSearchParams(window.location.search).get("code");
    if (!urlCode) return;
    autoTriedRef.current = true;
    void reviewCode(urlCode);
  }, [user]);

  const onApprove = async () => {
    if (!pending || !user || registration.data?.status !== "ready") return;
    setError(null);
    setSubmitting(true);
    let localPinPersisted = false;
    try {
      const localIdentity = await loadBrowserDeviceIdentity(user.id);
      if (
        localIdentity === null ||
        localIdentity.publicKeyWire !== registration.data.device.public_key
      ) {
        throw new ApprovalIdentityError(
          "Local browser identity changed; refresh and review the daemon again",
        );
      }
      const expectedFingerprint = await ed25519PublicKeyFingerprint(pending.host_public_key);
      if (pending.host_key_fingerprint !== expectedFingerprint) {
        throw new ApprovalIdentityError(
          "Daemon fingerprint changed after review; approval was blocked",
        );
      }
      await approveBrowserHostPin({
        accountId: user.id,
        origin: browserHostPinServerOrigin(),
        hostPublicKey: pending.host_public_key,
        hostFingerprint: expectedFingerprint,
      });
      localPinPersisted = true;
      setLocalPinCommitted(true);
      setLocalPinState("active");
      const signature = await createHostPairApprovalProof(
        localIdentity,
        user.id,
        pending.approval_nonce,
        pending.host_public_key,
      );
      const r = await auth.approveDevice({
        user_code: code.trim().toUpperCase(),
        approval_nonce: pending.approval_nonce,
        host_key_algorithm: pending.host_key_algorithm,
        host_public_key: pending.host_public_key,
        host_key_fingerprint: pending.host_key_fingerprint,
        browser_device_id: registration.data.device.id,
        browser_key_algorithm: registration.data.device.key_algorithm,
        browser_public_key: registration.data.device.public_key,
        browser_key_fingerprint: registration.data.device.fingerprint,
        signature,
      });
      if (
        r.host_name !== pending.host_name ||
        r.approval_nonce !== pending.approval_nonce ||
        r.host_key_algorithm !== pending.host_key_algorithm ||
        r.host_public_key !== pending.host_public_key ||
        r.host_key_fingerprint !== pending.host_key_fingerprint ||
        r.browser_device_id !== registration.data.device.id ||
        r.browser_key_algorithm !== registration.data.device.key_algorithm ||
        r.browser_public_key !== registration.data.device.public_key ||
        r.browser_key_fingerprint !== registration.data.device.fingerprint
      ) {
        throw new ApprovalIdentityError(
          "Approval response changed the reviewed host or browser identity",
        );
      }
      setHostName(r.host_name);
      void seedApprovedHostBinding({
        accountId: user.id,
        hostPublicKey: pending.host_public_key,
        hostFingerprint: expectedFingerprint,
        knownHostId: r.host_id,
      });
      setPending(null);
      setLocalPinState(null);
      setLocalPinCommitted(false);
      setCode("");
    } catch (err) {
      const message =
        err instanceof ApiError || err instanceof ApprovalIdentityError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Approval failed";
      setError(
        localPinPersisted
          ? `The exact host fingerprint is saved locally, but server approval did not complete: ${message}. Retry server approval or review the code again; the local pin will remain.`
          : message,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const deviceLabel =
    registration.data?.status === "ready" ? (registration.data.device.label ?? null) : null;

  return (
    <div className="mx-auto max-w-md p-4">
      <Card>
        <CardHeader>
          <CardTitle>Connect a host</CardTitle>
          <CardDescription>
            Run <code>spawnd possess</code> on the host you want to reach. It opens this page for
            you — check that the fingerprint here matches the one in your terminal, then approve.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={onReview}>
            <div className="space-y-1">
              <Label htmlFor="user_code">Code from the terminal</Label>
              <Input
                id="user_code"
                placeholder="QZ4K-7HMT"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setPending(null);
                  setLocalPinState(null);
                  setLocalPinCommitted(false);
                  setHostName(null);
                }}
                required
                disabled={pending !== null}
              />
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            {registration.isError && (
              <p className="text-sm text-destructive" role="alert">
                This browser&apos;s identity registration failed, so it cannot approve hosts. Reload
                to retry.
              </p>
            )}
            {registration.data && registration.data.status !== "ready" && (
              <p className="text-sm text-destructive" role="alert">
                This browser&apos;s identity is {registration.data.status.replace("_", " ")}, so it
                cannot approve hosts.
              </p>
            )}
            {hostName && (
              <p className="text-sm text-foreground" role="status">
                <code>{hostName}</code> is connected. Its terminals are available from the Agents
                page within a few seconds.
              </p>
            )}
            {pending ? (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    Check the fingerprint for <code>{pending.host_name}</code>
                  </p>
                  <p
                    className="break-all rounded bg-muted px-2 py-1.5 font-mono text-sm font-semibold"
                    data-testid="host-key-fingerprint"
                  >
                    {pending.host_key_fingerprint}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    The terminal running <code>spawnd login</code> printed the same value. If the
                    two differ, stop — someone may be between you and the host.
                  </p>
                </div>
                {localPinState === "active" && (
                  <p className="text-xs text-muted-foreground" data-testid="local-pin-state">
                    This host key is already active in this browser, so approving again only
                    completes the server side — local trust is unchanged.
                  </p>
                )}
                {localPinState === "revoked" && (
                  <p className="text-xs text-destructive" data-testid="local-pin-state">
                    You previously removed this exact host key from this browser (a deletion
                    tombstone remains). Approving now deliberately trusts this same key again.
                  </p>
                )}
                {localPinState === "new" && (
                  <p className="text-xs text-muted-foreground" data-testid="local-pin-state">
                    Approving saves this host key in this browser first, then registers the approval
                    with the server.
                  </p>
                )}
                {localPinCommitted && (
                  <p className="text-xs font-medium text-foreground" role="status">
                    Host key saved in this browser. If the server step fails, retrying is safe.
                  </p>
                )}
                <div className="space-y-1 border-t border-border pt-2">
                  <p className="text-xs text-muted-foreground">
                    Approving as{deviceLabel ? ` ${deviceLabel},` : ""} this browser&apos;s key:
                  </p>
                  <p
                    className="break-all font-mono text-xs text-muted-foreground"
                    data-testid="browser-key-fingerprint"
                  >
                    {registration.data?.status === "ready"
                      ? registration.data.device.fingerprint
                      : "unavailable"}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    className="flex-1"
                    disabled={submitting || registration.data?.status !== "ready"}
                    onClick={onApprove}
                  >
                    {submitting
                      ? "Approving..."
                      : localPinCommitted
                        ? "Retry server approval"
                        : localPinState === "revoked"
                          ? "Approve this host again"
                          : "Fingerprint matches — approve"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={submitting}
                    onClick={() => {
                      setPending(null);
                      setLocalPinState(null);
                      setLocalPinCommitted(false);
                    }}
                  >
                    Back
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? "Checking..." : "Look up host"}
              </Button>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
