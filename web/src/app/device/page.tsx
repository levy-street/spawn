"use client";

import { AlertTriangle } from "lucide-react";
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
import { publishHostIntroductionBroadcast } from "@/lib/host-gossip";
import { ed25519PublicKeyFingerprint } from "@/lib/signed-signal";

class ApprovalIdentityError extends Error {}

/**
 * The `#k=` URL fragment is the possession ceremony's out-of-band channel:
 * the daemon appends its OWN public key to the approval URL locally, after
 * receiving `verification_uri`, and the fragment travels terminal→browser
 * without ever appearing in an HTTP request — the server cannot see, strip,
 * or rewrite it in flight. Its value is what the server-claimed host key
 * must equal EXACTLY; on any difference nothing is pinned or approved.
 *
 * Returns the wire-encoded key, `null` when the URL carries no `k` fragment
 * (an older daemon, a retyped URL — the fingerprint-compare fallback), or
 * `"malformed"` when a `k` value is present but is not a canonical ed25519
 * wire key — a damaged or truncated link is refused, never downgraded.
 */
function readFragmentHostKey(hash: string): string | null | "malformed" {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const value = new URLSearchParams(raw).get("k");
  if (value === null) return null;
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : "malformed";
}

const REFUSAL_MISMATCH =
  "This host's identity could not be verified: the server presented a different identity " +
  "key than the one in your host's link. Nothing was trusted and no access was granted. " +
  "This can mean the connection is being tampered with — start over from the host's " +
  "terminal, on a network you trust.";
const REFUSAL_MALFORMED =
  "The identity check in this link (the part after '#') is damaged or cut off, so this " +
  "host could not be verified. Nothing was trusted. Copy the entire link from the host's " +
  "terminal and open it again.";

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
 * Possessing a host (docs/TRUST_UX.md §4): `spawnd possess` opens/prints a
 * link that carries the host's identity key in its URL fragment. This page
 * checks the server's claimed key against that out-of-band value invisibly;
 * on an exact match the human's one step is a single Approve click. A
 * mismatch is refused outright. Links with no fragment (older hosts, retyped
 * URLs) fall back to comparing the full fingerprint against the terminal —
 * never a weaker check, and never a silent pin.
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
  // The out-of-band host key from the URL fragment; null → fingerprint fallback.
  const fragmentKeyRef = useRef<string | null>(null);
  // Terminal refusal (fragment mismatch / damaged link). Nothing was trusted.
  const [refusal, setRefusal] = useState<string | null>(null);
  // True once the pending host key equaled the fragment key exactly — the
  // invisible check passed, so the screen is a plain Approve confirmation.
  const [fragmentVerified, setFragmentVerified] = useState(false);
  const [hostName, setHostName] = useState<string | null>(null);
  const [pending, setPending] = useState<DevicePendingApproval | null>(null);
  const [localPinState, setLocalPinState] = useState<BrowserHostPinState | "new" | null>(null);
  const [localPinCommitted, setLocalPinCommitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stopped, setStopped] = useState(false);

  // Load the pending approval. Takes the opaque URL ref the terminal
  // opened/printed (or the pre-0029 user_code URL param) and remembers which,
  // so approve reuses the exact same identifier. The fragment check happens
  // here, before anything is shown or stored: the server-claimed key either
  // exactly equals the out-of-band key or the ceremony is refused.
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
      // THE substitution check (docs/TRUST_DEVICE_MESH.md): the server's
      // claimed key against the key the host's own link carried out-of-band.
      // A hostile relay cannot pass this without controlling the terminal.
      const fragmentKey = fragmentKeyRef.current;
      if (fragmentKey !== null && r.host_public_key !== fragmentKey) {
        setRefusal(REFUSAL_MISMATCH);
        return;
      }
      if (!user) throw new ApprovalIdentityError("The authenticated account is unavailable");
      const existing = await loadBrowserHostPin({
        accountId: user.id,
        origin: browserHostPinServerOrigin(),
        hostPublicKey: r.host_public_key,
        hostFingerprint: expectedFingerprint,
      });
      setFragmentVerified(fragmentKey !== null);
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

  // The daemon opens this page with an opaque handle baked into the URL
  // (`/device?ref=…`, or `?code=…` from a pre-0029 server) and its own host
  // key in the `#k=` fragment. Read both, then auto-load once the account is
  // known, landing straight on the approve (or fallback-compare) screen.
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
    const fragment = readFragmentHostKey(window.location.hash);
    if (fragment === "malformed") {
      // A present-but-broken identity check is refused, never downgraded to
      // the fingerprint fallback: the link was damaged, not merely old.
      setRefusal(REFUSAL_MALFORMED);
      return;
    }
    fragmentKeyRef.current = fragment;
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
      // Defense in depth: re-assert the out-of-band binding at the moment of
      // signing, so no state shuffle can approve a key the fragment never
      // vouched for.
      if (fragmentKeyRef.current !== null && pending.host_public_key !== fragmentKeyRef.current) {
        throw new ApprovalIdentityError(
          "The host's identity no longer matches its link; nothing was trusted",
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
      // Continuous gossip (mesh R7): the moment this device verifies a host,
      // it vouches the key to the account so its firsthand-known peers pin it
      // too. Best-effort — the background reconcile sweep republishes anything
      // this misses (e.g. a first pairing whose Host row is not created yet).
      if (r.host_id) {
        const publishTarget = {
          hostId: r.host_id,
          hostName: r.host_name,
          hostPublicKey: pending.host_public_key,
        };
        void (async () => {
          try {
            const signer = await loadBrowserDeviceIdentity(user.id);
            if (signer === null || registration.data?.status !== "ready") return;
            await publishHostIntroductionBroadcast({
              accountId: user.id,
              deviceId: registration.data.device.id,
              identity: signer,
              target: publishTarget,
            });
          } catch {
            // The sweep is the durable path.
          }
        })();
      }
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

  const resetCeremony = () => {
    setPending(null);
    setFragmentVerified(false);
    setRefusal(null);
    setLocalPinState(null);
    setLocalPinCommitted(false);
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
  const busy =
    phase === "init" || (phase === "auto" && !pending && !hostName && !error && !refusal);

  // The fallback human check (no fragment), mapped onto the shared component.
  const checkPhase = stopped
    ? ("stopped" as const)
    : hostName
      ? ("done" as const)
      : submitting && pending
        ? ("waiting" as const)
        : pending
          ? ("compare" as const)
          : ("connecting" as const);
  // A server approval that failed after the local pin landed needs a retry
  // surface, not the check again — the identity check already passed.
  const retryable = Boolean(error && localPinCommitted && pending);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center p-4">
      <Card>
        <CardContent className="space-y-5 p-6">
          {refusal ? (
            <div className="flex min-h-[320px] flex-col" data-testid="possess-refusal">
              <div className="flex flex-1 flex-col items-center justify-center gap-4">
                <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                  <AlertTriangle className="size-6" />
                </div>
                <h2 className="text-lg font-medium tracking-tight text-foreground">
                  This host could not be verified
                </h2>
                <p
                  className="max-w-[30ch] text-balance text-center text-sm leading-relaxed text-muted-foreground"
                  role="alert"
                >
                  {refusal}
                </p>
              </div>
              <Button className="w-full" variant="secondary" onClick={resetCeremony}>
                Close
              </Button>
            </div>
          ) : hostName || pending || busy || stopped ? (
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
              ) : pending && fragmentVerified && !hostName ? (
                <div className="flex min-h-[320px] flex-col" data-testid="possess-approve-screen">
                  <div className="flex flex-1 flex-col items-center justify-center">
                    <p className="max-w-[30ch] text-balance text-center text-sm leading-relaxed text-muted-foreground">
                      This browser verified the host&apos;s identity against the link from its
                      terminal. Approving grants all your devices access to it.
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Button
                      type="button"
                      className="w-full"
                      data-testid="possess-approve"
                      disabled={submitting}
                      onClick={() => void onApprove()}
                    >
                      {submitting ? "Approving…" : `Approve ${pending.host_name}`}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full"
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
                  fingerprint={pending?.host_key_fingerprint}
                  otherScreen="in the host's terminal"
                  doneText={`${hostName} is possessed. All your devices can reach it.`}
                  stoppedText="The fingerprints don't match, so nothing was trusted. Start over from the host's terminal."
                  onMatch={() => void onApprove()}
                  onNoMatch={() => {
                    // Fingerprint mismatch is terminal.
                    setStopped(true);
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
                Its terminal opens this approval in your browser. The link carries the host&apos;s
                identity, so finishing is a single click.
              </p>
              <p className="text-center text-xs text-muted-foreground/80">
                On a remote host, copy the whole link the terminal prints — including the part after
                &apos;#&apos; — into any browser.
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
