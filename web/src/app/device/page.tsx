"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { NumberCheck } from "@/components/access/number-check";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  b64urlDecode,
  b64urlEncode,
  sas as computeSas,
  FIELD_BYTES,
  verifyCommit,
} from "@/lib/sas";
import { ed25519PublicKeyFingerprint } from "@/lib/signed-signal";

class ApprovalIdentityError extends Error {}

const POSSESS_TRIES = 3;

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

/**
 * Possessing a host (docs/TRUST_UX.md): `spawnd possess` prints a code that
 * opens this page; the host's terminal then shows a six-digit number and this
 * device TYPES it. The entry is the check — a correct number approves; three
 * misses abort. Older hosts with no number fall back to comparing the full
 * fingerprint, never a weaker code.
 */
function DeviceInner() {
  const { user } = useAuth();
  const router = useRouter();
  const registration = useBrowserDeviceRegistration(user?.id);
  // Set on a successful approval; drives the "possessed" screen and the
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
  // Set if the SAS number never arrives (daemon gone/slow), or the operator
  // says "I don't see a number" — then we fall back to the always-sound
  // fingerprint so the human is never stuck.
  const [sasTimedOut, setSasTimedOut] = useState(false);
  const [hostName, setHostName] = useState<string | null>(null);
  const [pending, setPending] = useState<DevicePendingApproval | null>(null);
  const [localPinState, setLocalPinState] = useState<BrowserHostPinState | "new" | null>(null);
  const [localPinCommitted, setLocalPinCommitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Entry-style check state: three tries, then the ceremony is over.
  const [triesLeft, setTriesLeft] = useState(POSSESS_TRIES);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);

  // Load the pending approval and land on the number screen. Takes the opaque
  // URL ref the terminal opened/printed (or the pre-0029 user_code URL param),
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
          "The host's identity did not check out; nothing was trusted",
        );
      }
      if (!user) throw new ApprovalIdentityError("The authenticated account is unavailable");
      const existing = await loadBrowserHostPin({
        accountId: user.id,
        origin: browserHostPinServerOrigin(),
        hostPublicKey: r.host_public_key,
        hostFingerprint: expectedFingerprint,
      });
      // The committed-ephemeral SAS number is computed by a separate effect once
      // the browser identity is ready (it needs our key B). No grindable code:
      // when the daemon offers no commitment we compare the full fingerprint.
      setVerifyCode(null);
      setSasTimedOut(false);
      sasStartedRef.current = false;
      setTriesLeft(POSSESS_TRIES);
      setEntryError(null);
      setStopped(false);
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

  // Committed-ephemeral SAS (docs/TRUST_DEVICE_MESH.md Appendix A). Once we hold
  // a pending ceremony that carries the daemon's commitment Cd and our browser
  // identity is ready, contribute our fresh nonce Nb + key B, wait for the daemon
  // to reveal Nd, verify Cd opens, and compute the number the host's terminal is
  // showing — this side never displays it, only checks the operator's entry.
  const sasStartedRef = useRef(false);
  const runSas = async (
    p: DevicePendingApproval,
    id: { user_code?: string; approval_ref?: string },
    browserPublicKey: string,
  ) => {
    if (!p.sas_commit) return; // pre-SAS daemon → fingerprint fallback in the UI
    try {
      const hostKey = b64urlDecode(p.host_public_key);
      const browserKey = b64urlDecode(browserPublicKey);
      const commit = b64urlDecode(p.sas_commit);
      const nb = crypto.getRandomValues(new Uint8Array(FIELD_BYTES));
      await auth.contributeSas({
        ...id,
        sas_browser_nonce: b64urlEncode(nb),
        browser_public_key: browserPublicKey,
      });
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      let nd: Uint8Array | null = null;
      for (let attempt = 0; attempt < 40 && !nd; attempt += 1) {
        const fresh = await auth.pendingDevice(id).catch(() => null);
        if (fresh?.sas_host_nonce) {
          nd = b64urlDecode(fresh.sas_host_nonce);
          break;
        }
        await sleep(1000);
      }
      if (!nd) {
        // The daemon never revealed its nonce — fall back to the fingerprint,
        // which both sides show, instead of leaving the human stuck.
        setSasTimedOut(true);
        return;
      }
      if (!(await verifyCommit(commit, hostKey, nd))) {
        throw new ApprovalIdentityError(
          "The host's number commitment did not open — nothing was trusted",
        );
      }
      setVerifyCode(await computeSas(hostKey, browserKey, nd, nb));
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof ApprovalIdentityError
          ? err.message
          : "Could not compute the check number",
      );
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot guarded by a ref; runSas intentionally omitted
  useEffect(() => {
    if (!pending?.sas_commit || verifyCode || sasStartedRef.current) return;
    if (registration.data?.status !== "ready") return;
    sasStartedRef.current = true;
    void runSas(pending, identifier ?? {}, registration.data.device.public_key);
  }, [pending, registration.data, verifyCode, identifier]);

  // The daemon opens this page with an opaque handle baked into the URL
  // (`/device?ref=…`, or `?code=…` from a pre-0029 server), so an approval needs
  // nothing typed. Set the phase from the URL, then auto-load once the account
  // is known, landing straight on the number screen.
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
  // Wait a beat so they read the done screen, and — on a first pairing, where
  // the approve response has no host id yet — poll briefly for the Host row the
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
          "This browser's identity changed; refresh and start over on the host",
        );
      }
      const expectedFingerprint = await ed25519PublicKeyFingerprint(pending.host_public_key);
      if (pending.host_key_fingerprint !== expectedFingerprint) {
        throw new ApprovalIdentityError(
          "The host's identity changed mid-check; nothing was trusted",
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
        ...(identifier ?? {}),
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
          "The approval response changed the reviewed host or browser identity",
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
          ? `The host's exact identity is saved in this browser, but the server step did not complete: ${message}. Retrying is safe.`
          : message,
      );
    } finally {
      setSubmitting(false);
    }
  };

  /** The typed digits ARE the check: match → approve; three misses → over. */
  const onSubmitDigits = (digits: string) => {
    if (!verifyCode || submitting) return;
    if (digits.replace(/\D/gu, "") === verifyCode.replace(/\D/gu, "")) {
      setEntryError(null);
      void onApprove();
      return;
    }
    const remaining = triesLeft - 1;
    if (remaining <= 0) {
      setTriesLeft(0);
      setStopped(true);
      return;
    }
    setTriesLeft(remaining);
    setEntryError(`That's not it — ${remaining} ${remaining === 1 ? "try" : "tries"} left.`);
  };

  const resetCeremony = () => {
    setPending(null);
    setVerifyCode(null);
    setSasTimedOut(false);
    setLocalPinState(null);
    setLocalPinCommitted(false);
    setEntryError(null);
    setTriesLeft(POSSESS_TRIES);
    setStopped(false);
    setError(null);
    setIdentifier(null);
    setPhase("manual");
  };

  const backToAccess = () => {
    router.push("/");
    openSettings("access");
  };

  const deviceLabel =
    registration.data?.status === "ready" ? (registration.data.device.label ?? null) : null;
  const registrationBlocked =
    registration.isError || (registration.data && registration.data.status !== "ready");
  const busy = phase === "init" || (phase === "auto" && !pending && !hostName && !error);

  // The one human check, mapped onto the shared component's phases.
  const checkPhase = stopped
    ? ("stopped" as const)
    : hostName
      ? ("done" as const)
      : submitting && pending
        ? ("waiting" as const)
        : pending && (verifyCode || sasTimedOut || !pending.sas_commit)
          ? ("compare" as const)
          : ("connecting" as const);
  const useFingerprint = Boolean(pending && (!pending.sas_commit || sasTimedOut));
  // A server approval that failed after the local pin landed needs a retry
  // surface, not the entry field again — the human check already passed.
  const retryable = Boolean(error && localPinCommitted && pending);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center p-4">
      <Card>
        <CardContent className="space-y-5 p-6">
          {hostName || pending || busy || stopped ? (
            <div className="space-y-4">
              {!hostName && !stopped && (
                <div className="text-center">
                  <p className="text-sm text-muted-foreground">Possess a host</p>
                  {pending && (
                    <p className="text-xl font-semibold text-foreground">{pending.host_name}</p>
                  )}
                </div>
              )}

              {retryable ? (
                <div className="space-y-3">
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      className="flex-1"
                      disabled={submitting}
                      onClick={() => void onApprove()}
                    >
                      {submitting ? "Retrying…" : "Retry"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={submitting}
                      onClick={resetCeremony}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <NumberCheck
                  phase={checkPhase}
                  mode="enter"
                  fingerprint={useFingerprint ? pending?.host_key_fingerprint : undefined}
                  otherScreen="in the host's terminal"
                  doneText={`${hostName} is possessed. All your devices can reach it.`}
                  entryError={entryError ?? undefined}
                  stoppedText="The number wasn't right, so nothing was trusted. Start over from the host's terminal."
                  onSubmit={onSubmitDigits}
                  onMatch={() => void onApprove()}
                  onNoMatch={() => {
                    if (useFingerprint || !pending?.sas_commit) {
                      // Fingerprint mismatch is terminal.
                      setStopped(true);
                    } else {
                      // "I don't see a number" — the always-sound fallback.
                      setSasTimedOut(true);
                    }
                  }}
                  onDone={() => router.push("/hosts")}
                  onClose={resetCeremony}
                />
              )}

              {localPinState === "revoked" && !stopped && !hostName && (
                <p className="text-xs text-destructive" data-testid="local-pin-state">
                  You previously removed this host from this browser. Continuing trusts it again.
                </p>
              )}
              {error && !retryable && !stopped && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4" data-testid="possess-instructions">
              <div className="space-y-1 text-center">
                <p className="text-lg font-medium text-foreground">Possess a host</p>
                <p className="text-sm text-muted-foreground">Run this on the host:</p>
              </div>
              <div className="rounded-lg border border-border bg-muted px-4 py-3 font-mono text-sm text-foreground">
                <span className="select-none text-muted-foreground">$ </span>spawnd possess
              </div>
              <p className="text-center text-sm leading-relaxed text-muted-foreground">
                Its terminal opens this approval in your browser and shows a six-digit number.
                You'll type the number to finish.
              </p>
              <p className="text-center text-xs text-muted-foreground/80">
                On a remote host, open the link the terminal prints.
              </p>
              {error && (
                <p className="text-center text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Button type="button" variant="ghost" className="w-full" onClick={backToAccess}>
                Cancel
              </Button>
            </div>
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
