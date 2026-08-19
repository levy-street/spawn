"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { verificationCode } from "@/lib/verification-code";

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
  const router = useRouter();
  const registration = useBrowserDeviceRegistration(user?.id);
  const [code, setCode] = useState("");
  // Set on a successful approval; drives the "connected" screen and the
  // hand-off to the host's page once its id is known.
  const [connected, setConnected] = useState<{
    hostPublicKey: string;
    hostId: string | null;
  } | null>(null);
  // The identifier a successful review was loaded with, reused verbatim by
  // approve: the opaque URL ref (normal auto-open path) or the typed user_code.
  const [identifier, setIdentifier] = useState<{
    user_code?: string;
    approval_ref?: string;
  } | null>(null);
  // "init" until the effect reads the URL: "auto" when a handle was baked in
  // (nothing to type), "manual" when the page was opened bare.
  const [phase, setPhase] = useState<"init" | "auto" | "manual">("init");
  const [verifyCode, setVerifyCode] = useState<string | null>(null);
  const [hostName, setHostName] = useState<string | null>(null);
  const [pending, setPending] = useState<DevicePendingApproval | null>(null);
  const [localPinState, setLocalPinState] = useState<BrowserHostPinState | "new" | null>(null);
  const [localPinCommitted, setLocalPinCommitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Load the pending approval and land on the fingerprint screen. Takes either
  // the opaque URL ref (auto-open path — nothing typed) or a typed user_code,
  // and remembers which so approve reuses the exact same identifier.
  const review = async (id: { user_code?: string; approval_ref?: string }) => {
    const lookup = id.approval_ref
      ? { approval_ref: id.approval_ref }
      : { user_code: (id.user_code ?? "").trim().toUpperCase() };
    if (!lookup.approval_ref && !lookup.user_code) return;
    setError(null);
    setSubmitting(true);
    try {
      const r = await auth.pendingDevice(lookup);
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
      setVerifyCode(await verificationCode(r.host_key_fingerprint));
      setIdentifier(lookup);
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
    void review({ user_code: code });
  };

  // The daemon opens this page with an opaque handle baked into the URL
  // (`/device?ref=…`, or `?code=…` from a pre-0029 server), so an approval needs
  // nothing typed. Set the phase from the URL, then auto-load once the account
  // is known, landing straight on the verification screen.
  const autoTriedRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot guarded by a ref; review intentionally omitted
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref");
    const urlCode = params.get("code");
    const hasHandle = Boolean(ref || urlCode);
    setPhase(hasHandle ? "auto" : "manual");
    if (!hasHandle || !user || autoTriedRef.current) return;
    autoTriedRef.current = true;
    void review(ref ? { approval_ref: ref } : { user_code: urlCode ?? undefined });
  }, [user]);

  // After a successful approval, hand the operator off to the new host's page.
  // Wait a beat so they read "connected", and — on a first pairing, where the
  // approve response has no host id yet — poll briefly for the Host row the
  // daemon's next poll creates. Falls back to the hosts list if it never lands.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const run = async () => {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      await sleep(3000);
      let hostId = connected.hostId;
      for (let attempt = 0; attempt < 6 && !hostId && !cancelled; attempt += 1) {
        const listed = await hosts.list().catch(() => null);
        hostId = listed?.find((h) => h.host_public_key === connected.hostPublicKey)?.id ?? null;
        if (!hostId) await sleep(2000);
      }
      if (!cancelled) router.push(hostId ? `/hosts/${hostId}` : "/hosts");
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [connected, router]);

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
        ...(identifier ?? { user_code: code.trim().toUpperCase() }),
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
      setConnected({ hostPublicKey: pending.host_public_key, hostId: r.host_id ?? null });
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
      setIdentifier(null);
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
  const registrationBlocked =
    registration.isError || (registration.data && registration.data.status !== "ready");
  const busy = phase === "init" || (phase === "auto" && !pending && !hostName && !error);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center p-4">
      <Card>
        <CardContent className="space-y-5 p-6">
          {hostName ? (
            <div className="space-y-1 text-center" role="status">
              <p className="text-lg font-medium text-foreground">
                <code>{hostName}</code> is connected.
              </p>
              <p className="text-sm text-muted-foreground">Taking you to it…</p>
            </div>
          ) : pending ? (
            <div className="space-y-5">
              <div className="text-center">
                <p className="text-sm text-muted-foreground">Approve this host</p>
                <p className="text-xl font-semibold text-foreground">{pending.host_name}</p>
              </div>

              <div className="space-y-2 rounded-lg border p-4 text-center">
                <p className="text-sm text-muted-foreground">
                  Confirm this matches the code in your terminal
                </p>
                <p
                  className="font-mono text-4xl font-semibold tracking-[0.15em] text-foreground tabular-nums"
                  data-testid="verification-code"
                >
                  {verifyCode ?? "— — —"}
                </p>
                <p
                  className="break-all font-mono text-[11px] text-muted-foreground/70"
                  data-testid="host-key-fingerprint"
                >
                  {pending.host_key_fingerprint}
                </p>
              </div>

              {localPinState === "revoked" && (
                <p className="text-xs text-destructive" data-testid="local-pin-state">
                  You previously removed this key from this browser. Approving trusts it again.
                </p>
              )}
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              {localPinCommitted && (
                <p className="text-xs text-muted-foreground" role="status">
                  Saved in this browser — retrying is safe.
                </p>
              )}

              <div className="flex gap-2">
                <Button
                  type="button"
                  className="flex-1"
                  disabled={submitting || registration.data?.status !== "ready"}
                  onClick={onApprove}
                >
                  {submitting
                    ? "Approving…"
                    : localPinCommitted
                      ? "Retry server approval"
                      : "Approve"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={submitting}
                  onClick={() => {
                    setPending(null);
                    setVerifyCode(null);
                    setLocalPinState(null);
                    setLocalPinCommitted(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : busy ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading host…</p>
          ) : (
            <form className="space-y-4" onSubmit={onReview}>
              <div className="space-y-1 text-center">
                <p className="text-lg font-medium text-foreground">Connect a host</p>
                <p className="text-sm text-muted-foreground">
                  Enter the code from <code>spawnd possess</code>.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="user_code" className="sr-only">
                  Code from the terminal
                </Label>
                <Input
                  id="user_code"
                  placeholder="QZ4K-7HMT"
                  inputMode="text"
                  autoCapitalize="characters"
                  autoComplete="one-time-code"
                  className="text-center font-mono text-lg tracking-[0.2em]"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setIdentifier(null);
                    setPending(null);
                    setVerifyCode(null);
                    setLocalPinState(null);
                    setLocalPinCommitted(false);
                    setHostName(null);
                  }}
                  required
                />
              </div>
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? "Checking…" : "Look up host"}
              </Button>
            </form>
          )}

          {registrationBlocked && (
            <p className="text-center text-xs text-destructive" role="alert">
              This browser can&apos;t approve hosts{deviceLabel ? ` (${deviceLabel})` : ""}. Reload
              to retry.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
