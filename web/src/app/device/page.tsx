"use client";

import { type FormEvent, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, auth, type DevicePendingApproval } from "@/lib/api";
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
  const [localBrowserFingerprint, setLocalBrowserFingerprint] = useState<string | null>(null);
  const [localPinState, setLocalPinState] = useState<BrowserHostPinState | "new" | null>(null);
  const [localPinCommitted, setLocalPinCommitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onReview = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const r = await auth.pendingDevice({
        user_code: code.trim().toUpperCase(),
      });
      const expectedFingerprint = await ed25519PublicKeyFingerprint(r.host_public_key);
      if (r.host_key_fingerprint !== expectedFingerprint) {
        throw new ApprovalIdentityError(
          "Daemon fingerprint did not match its public key; approval was blocked",
        );
      }
      if (!user) throw new ApprovalIdentityError("The authenticated account is unavailable");
      if (registration.data?.status !== "ready") {
        throw new ApprovalIdentityError("The local browser identity is not ready for approval");
      }
      const localIdentity = await loadBrowserDeviceIdentity(user.id);
      if (
        localIdentity === null ||
        localIdentity.publicKeyWire !== registration.data.device.public_key
      ) {
        throw new ApprovalIdentityError(
          "Local browser identity changed; refresh before reviewing the daemon",
        );
      }
      const derivedBrowserFingerprint = await ed25519PublicKeyFingerprint(
        localIdentity.publicKeyWire,
      );
      if (registration.data.device.fingerprint !== derivedBrowserFingerprint) {
        throw new ApprovalIdentityError(
          "Browser registration fingerprint did not match the locally stored key",
        );
      }
      const existing = await loadBrowserHostPin({
        accountId: user.id,
        origin: browserHostPinServerOrigin(),
        hostPublicKey: r.host_public_key,
        hostFingerprint: expectedFingerprint,
      });
      setPending(r);
      setLocalBrowserFingerprint(derivedBrowserFingerprint);
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
      const derivedBrowserFingerprint = await ed25519PublicKeyFingerprint(
        localIdentity.publicKeyWire,
      );
      if (
        derivedBrowserFingerprint !== localBrowserFingerprint ||
        registration.data.device.fingerprint !== derivedBrowserFingerprint
      ) {
        throw new ApprovalIdentityError(
          "Locally derived browser fingerprint changed; refresh and review the daemon again",
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
        browser_public_key: localIdentity.publicKeyWire,
        browser_key_fingerprint: derivedBrowserFingerprint,
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
        r.browser_public_key !== localIdentity.publicKeyWire ||
        r.browser_key_fingerprint !== derivedBrowserFingerprint
      ) {
        throw new ApprovalIdentityError(
          "Approval response changed the reviewed host or browser identity",
        );
      }
      setHostName(r.host_name);
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

  return (
    <div className="mx-auto max-w-md p-4">
      <Card>
        <CardHeader>
          <CardTitle>Approve a daemon</CardTitle>
          <CardDescription>
            Enter the code shown by <code>spawnd login</code> on the host you want to register.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={onReview}>
            <div className="space-y-1">
              <Label htmlFor="user_code">Device code</Label>
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
                  setLocalBrowserFingerprint(null);
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
                Browser identity registration failed; approval is unavailable.
              </p>
            )}
            {registration.data && registration.data.status !== "ready" && (
              <p className="text-sm text-destructive" role="alert">
                This browser identity is {registration.data.status.replace("_", " ")}; approval is
                unavailable.
              </p>
            )}
            {hostName && (
              <div className="space-y-2 text-sm text-foreground" role="status">
                <p>
                  Approved daemon for host <code>{hostName}</code>. It should connect after you
                  complete reciprocal browser verification on that host.
                </p>
                <p>This browser&apos;s locally derived full fingerprint:</p>
                <p
                  className="break-all font-mono text-sm font-semibold"
                  data-testid="browser-key-fingerprint"
                >
                  {localBrowserFingerprint ?? "unavailable"}
                </p>
                <p className="text-xs text-muted-foreground">
                  At the <code>spawnd login</code> prompt, enter this exact full value. For a
                  non-interactive login, pass it as <code>--expect-browser-fingerprint</code>. Do
                  not shorten, retype, or change its case.
                </p>
              </div>
            )}
            {pending ? (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm">
                  Confirm host <code>{pending.host_name}</code> with fingerprint:
                </p>
                <p
                  className="break-all font-mono text-sm font-semibold"
                  data-testid="host-key-fingerprint"
                >
                  {pending.host_key_fingerprint}
                </p>
                <p className="text-xs text-muted-foreground">
                  Compare this with the fingerprint printed by <code>spawnd login</code>.
                </p>
                {localPinState === "active" && (
                  <p className="text-xs text-muted-foreground" data-testid="local-pin-state">
                    This exact fingerprint is already active in this browser. Confirm retries or
                    completes the server approval without replacing local trust.
                  </p>
                )}
                {localPinState === "revoked" && (
                  <p className="text-xs text-destructive" data-testid="local-pin-state">
                    This exact fingerprint has a local deletion tombstone. Confirming this fresh
                    ceremony explicitly reactivates only this same key.
                  </p>
                )}
                {localPinState === "new" && (
                  <p className="text-xs text-muted-foreground" data-testid="local-pin-state">
                    Confirmation first saves this exact fingerprint locally, then sends server
                    approval.
                  </p>
                )}
                {localPinCommitted && (
                  <p className="text-xs font-medium text-foreground" role="status">
                    Exact host fingerprint saved locally. Server approval can be retried safely.
                  </p>
                )}
                <p className="text-sm">This browser&apos;s locally derived full fingerprint:</p>
                <p
                  className="break-all font-mono text-sm font-semibold"
                  data-testid="browser-key-fingerprint"
                >
                  {localBrowserFingerprint ?? "unavailable"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Keep this exact full value available. After approval, copy it to the waiting
                  daemon prompt; the daemon will not trust the server to supply it.
                </p>
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
                          ? "Confirm reapproval"
                          : "Confirm approval"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={submitting}
                    onClick={() => {
                      setPending(null);
                      setLocalPinState(null);
                      setLocalPinCommitted(false);
                      setLocalBrowserFingerprint(null);
                    }}
                  >
                    Back
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? "Checking..." : "Review daemon"}
              </Button>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
