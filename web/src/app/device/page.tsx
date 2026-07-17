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
import { useBrowserDeviceRegistration } from "@/lib/browser-device-registration";
import {
  type BrowserHostPinState,
  browserHostPinServerOrigin,
  loadBrowserHostPin,
} from "@/lib/browser-host-pins";
import { useBrowserTrustEpochCapabilities } from "@/lib/browser-trust-capabilities";
import {
  approveDeviceWithinTrustEpoch,
  BrowserTrustOperationError,
} from "@/lib/browser-trust-operations";
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
  const capabilities = useBrowserTrustEpochCapabilities();
  const [code, setCode] = useState("");
  const [hostName, setHostName] = useState<string | null>(null);
  const [pending, setPending] = useState<DevicePendingApproval | null>(null);
  const [localPinState, setLocalPinState] = useState<BrowserHostPinState | "new" | null>(null);
  const [localPinCommitted, setLocalPinCommitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onReview = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (!user || registration.data?.status !== "ready") {
        throw new ApprovalIdentityError("An active browser trust epoch is required");
      }
      const lease = capabilities.acquire({
        accountOwnerUserId: user.id,
        browserDeviceId: registration.data.device.id,
        browserPublicKey: registration.data.device.public_key,
        epochKey: capabilities.expectation.epochKey,
      });
      const r = await auth.pendingDevice({ user_code: code.trim().toUpperCase() }, lease.signal);
      lease.assertActive();
      const expectedFingerprint = await ed25519PublicKeyFingerprint(r.host_public_key);
      lease.assertActive();
      if (r.host_key_fingerprint !== expectedFingerprint) {
        throw new ApprovalIdentityError(
          "Daemon fingerprint did not match its public key; approval was blocked",
        );
      }
      const existing = await loadBrowserHostPin(
        {
          accountId: lease.accountOwnerUserId,
          origin: browserHostPinServerOrigin(),
          hostPublicKey: r.host_public_key,
          hostFingerprint: expectedFingerprint,
        },
        { signal: lease.signal },
      );
      lease.assertActive();
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

  const onApprove = async () => {
    if (!pending || !user || registration.data?.status !== "ready") return;
    setError(null);
    setSubmitting(true);
    try {
      const lease = capabilities.acquire({
        accountOwnerUserId: user.id,
        browserDeviceId: registration.data.device.id,
        browserPublicKey: registration.data.device.public_key,
        epochKey: capabilities.expectation.epochKey,
      });
      const r = await approveDeviceWithinTrustEpoch({
        lease,
        userCode: code.trim().toUpperCase(),
        pending,
        origin: browserHostPinServerOrigin(),
        registration: {
          deviceId: registration.data.device.id,
          keyAlgorithm: registration.data.device.key_algorithm,
          publicKey: registration.data.device.public_key,
          fingerprint: registration.data.device.fingerprint,
        },
      });
      setLocalPinCommitted(true);
      setLocalPinState("active");
      setHostName(r.host_name);
      setPending(null);
      setLocalPinState(null);
      setLocalPinCommitted(false);
      setCode("");
    } catch (err) {
      if (err instanceof BrowserTrustOperationError && err.recovery !== "none") {
        setLocalPinCommitted(true);
        setLocalPinState("active");
      }
      const message =
        err instanceof ApiError ||
        err instanceof ApprovalIdentityError ||
        err instanceof BrowserTrustOperationError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Approval failed";
      setError(message);
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
              <p className="text-sm text-foreground" role="status">
                Approved daemon for host <code>{hostName}</code>. It should connect within a few
                seconds.
              </p>
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
                <p className="text-sm">Approving browser fingerprint:</p>
                <p
                  className="break-all font-mono text-sm font-semibold"
                  data-testid="browser-key-fingerprint"
                >
                  {registration.data?.status === "ready"
                    ? registration.data.device.fingerprint
                    : "unavailable"}
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
