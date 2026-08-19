"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Terminal } from "lucide-react";
import { type FormEvent, type JSX, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusDot } from "@/components/ui/status";
import { ApiError, auth, type DevicePendingApproval, type Host, hosts } from "@/lib/api";
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
import { detectPlatform, UNDETECTED_PLATFORM } from "@/lib/platform";
import { ed25519PublicKeyFingerprint } from "@/lib/signed-signal";

class ApprovalIdentityError extends Error {}

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
    // The key pin is already durable. A later exact-key lookup heals the ID binding.
  }
}

export function ConnectHostSection(props: { onHostOnline?: (host: Host) => void }): JSX.Element {
  const { onHostOnline } = props;
  const [platform, setPlatform] = useState(UNDETECTED_PLATFORM);
  const [copied, setCopied] = useState(false);
  const notifiedRef = useRef(false);
  const hostsQ = useQuery({
    queryKey: ["hosts"],
    queryFn: hosts.list,
    refetchInterval: 3_000,
  });
  const onlineHost = hostsQ.data?.find((host) => host.status === "online");

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  useEffect(() => {
    if (!onlineHost || notifiedRef.current) return;
    notifiedRef.current = true;
    onHostOnline?.(onlineHost);
  }, [onlineHost, onHostOnline]);

  const platformName =
    platform.os === "macos"
      ? "macOS"
      : platform.os === "linux"
        ? "Linux"
        : platform.os === "windows"
          ? "Windows"
          : "your machine";

  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader>
        <CardTitle>Connect a host</CardTitle>
        <CardDescription>
          Install the daemon on the machine where your sessions should run, then approve its
          one-time pairing code.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <section aria-labelledby="install-daemon-title" className="space-y-2">
          <div className="flex items-center gap-2">
            <Terminal className="size-4 text-muted-foreground" aria-hidden />
            <h3 id="install-daemon-title" className="text-sm font-medium">
              Install on {platformName}
            </h3>
          </div>
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted p-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-1 font-mono text-xs">
              {platform.installCommand}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label="Copy install command"
              onClick={async () => {
                await navigator.clipboard.writeText(platform.installCommand);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1_500);
              }}
            >
              {copied ? (
                <Check className="size-4 text-success" aria-hidden />
              ) : (
                <Copy className="size-4" aria-hidden />
              )}
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            After installation, run <code>spawnd login</code> on that machine.
          </p>
        </section>

        <div className="h-px bg-border" />

        <section aria-labelledby="pair-host-title" className="space-y-3">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" aria-hidden />
            <h3 id="pair-host-title" className="text-sm font-medium">
              Enter a pairing code
            </h3>
          </div>
          <PairingCodeForm />
        </section>

        <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
          <StatusDot
            tone={onlineHost ? "active" : "waiting"}
            pulse={!onlineHost}
            label={onlineHost ? `${onlineHost.name} is online` : "Waiting for your machine"}
          />
          <span>{onlineHost ? `${onlineHost.name} is online.` : "Waiting for your machine…"}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export function PairingCodeForm({ onApproved }: { onApproved?: (hostName: string) => void } = {}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const registration = useBrowserDeviceRegistration(user?.id);
  const [code, setCode] = useState("");
  const [hostName, setHostName] = useState<string | null>(null);
  const [pending, setPending] = useState<DevicePendingApproval | null>(null);
  const [localPinState, setLocalPinState] = useState<BrowserHostPinState | "new" | null>(null);
  const [localPinCommitted, setLocalPinCommitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onReview = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await auth.pendingDevice({ user_code: code.trim().toUpperCase() });
      const expectedFingerprint = await ed25519PublicKeyFingerprint(response.host_public_key);
      if (response.host_key_fingerprint !== expectedFingerprint) {
        throw new ApprovalIdentityError(
          "Daemon fingerprint did not match its public key; approval was blocked",
        );
      }
      if (!user) throw new ApprovalIdentityError("The authenticated account is unavailable");
      const existing = await loadBrowserHostPin({
        accountId: user.id,
        origin: browserHostPinServerOrigin(),
        hostPublicKey: response.host_public_key,
        hostFingerprint: expectedFingerprint,
      });
      setPending(response);
      setLocalPinState(existing?.state ?? "new");
      setLocalPinCommitted(existing?.state === "active");
    } catch (caught) {
      setError(
        caught instanceof ApiError || caught instanceof ApprovalIdentityError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : "Approval failed",
      );
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
      const response = await auth.approveDevice({
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
        response.host_name !== pending.host_name ||
        response.approval_nonce !== pending.approval_nonce ||
        response.host_key_algorithm !== pending.host_key_algorithm ||
        response.host_public_key !== pending.host_public_key ||
        response.host_key_fingerprint !== pending.host_key_fingerprint ||
        response.browser_device_id !== registration.data.device.id ||
        response.browser_key_algorithm !== registration.data.device.key_algorithm ||
        response.browser_public_key !== registration.data.device.public_key ||
        response.browser_key_fingerprint !== registration.data.device.fingerprint
      ) {
        throw new ApprovalIdentityError(
          "Approval response changed the reviewed host or browser identity",
        );
      }
      setHostName(response.host_name);
      onApproved?.(response.host_name);
      void seedApprovedHostBinding({
        accountId: user.id,
        hostPublicKey: pending.host_public_key,
        hostFingerprint: expectedFingerprint,
        knownHostId: response.host_id,
      });
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
      setPending(null);
      setLocalPinState(null);
      setLocalPinCommitted(false);
      setCode("");
    } catch (caught) {
      const message =
        caught instanceof ApiError || caught instanceof ApprovalIdentityError
          ? caught.message
          : caught instanceof Error
            ? caught.message
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
    <form className="space-y-3" onSubmit={onReview}>
      <div className="space-y-1.5">
        <Label htmlFor="host-pairing-code">Code from the terminal</Label>
        <Input
          id="host-pairing-code"
          placeholder="QZ4K-7HMT"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => {
            setCode(event.currentTarget.value);
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
          This browser&apos;s identity registration failed, so it cannot approve hosts. Reload to
          retry.
        </p>
      )}
      {registration.data && registration.data.status !== "ready" && (
        <p className="text-sm text-destructive" role="alert">
          This browser&apos;s identity is {registration.data.status.replace("_", " ")}, so it cannot
          approve hosts.
        </p>
      )}
      {hostName && (
        <p className="text-sm text-success" role="status">
          {hostName} is connected. It will appear as soon as its daemon comes online.
        </p>
      )}

      {pending ? (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              Check the fingerprint for <code>{pending.host_name}</code>
            </p>
            <p
              className="break-all rounded-md bg-muted px-2 py-1.5 font-mono text-sm font-semibold"
              data-testid="host-key-fingerprint"
            >
              {pending.host_key_fingerprint}
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              Confirm the terminal shows this exact value. If it differs, stop—the connection may be
              intercepted.
            </p>
          </div>
          {localPinState === "active" && (
            <p className="text-xs text-muted-foreground" data-testid="local-pin-state">
              This exact host key is already active in this browser. Approving again only completes
              the server side.
            </p>
          )}
          {localPinState === "revoked" && (
            <p className="text-xs text-destructive" data-testid="local-pin-state">
              You previously removed this host key. Approving deliberately trusts the same key
              again.
            </p>
          )}
          {localPinState === "new" && (
            <p className="text-xs text-muted-foreground" data-testid="local-pin-state">
              Approval saves this host key in this browser before registering it with the server.
            </p>
          )}
          {localPinCommitted && (
            <p className="text-xs font-medium text-foreground" role="status">
              Host key saved locally. Retrying the server approval is safe.
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
          <div className="flex flex-col-reverse gap-2 @sm/settings:flex-row">
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
                  : localPinState === "revoked"
                    ? "Approve this host again"
                    : "Fingerprint matches — approve"}
            </Button>
          </div>
        </div>
      ) : (
        <Button type="submit" className="w-full" disabled={submitting || !code.trim()}>
          {submitting ? "Checking…" : "Look up host"}
        </Button>
      )}
    </form>
  );
}
