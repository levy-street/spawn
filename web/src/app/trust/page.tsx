"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trust } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { browserHostPinServerOrigin, listActiveBrowserHostPins } from "@/lib/browser-host-pins";
import {
  createTrustPasskey,
  evaluateTrustPrf,
  isPasskeySupported,
  PasskeyPrfError,
} from "@/lib/passkey-prf";
import { importTrustBundle, sealCurrentTrust } from "@/lib/trust-bootstrap";
import { deriveTrustBundleKey } from "@/lib/trust-bundle";

function describe(error: unknown): string {
  if (error instanceof PasskeyPrfError) {
    switch (error.code) {
      case "prf_unavailable":
        return "This passkey cannot derive a trust secret. Its authenticator does not support the PRF extension, so this device needs the endorsement path instead.";
      case "cancelled":
        return "The passkey prompt was dismissed.";
      case "no_credential":
        return "No passkey was offered for this account on this device.";
      case "unsupported":
        return "This browser cannot use passkeys here. A secure context (HTTPS) is required.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export default function TrustPage() {
  return (
    <AuthGate>
      <AppShell>
        <TrustSettings />
      </AppShell>
    </AuthGate>
  );
}

function TrustSettings() {
  const { user } = useAuth();
  const accountId = user?.id ?? null;
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const passkeys = useQuery({
    queryKey: ["trust", "passkeys"],
    queryFn: () => trust.listPasskeys(),
    enabled: accountId !== null,
  });
  const bundle = useQuery({
    queryKey: ["trust", "bundle"],
    queryFn: () => trust.getBundle(),
    enabled: accountId !== null,
  });
  const localPins = useQuery({
    queryKey: ["trust", "local-pins", accountId],
    queryFn: () =>
      listActiveBrowserHostPins({
        accountId: accountId as string,
        origin: browserHostPinServerOrigin(),
      }),
    enabled: accountId !== null,
  });

  function begin() {
    setStatus(null);
    setError(null);
  }

  /**
   * Create a passkey, then seal this device's verified hosts under it. Creation
   * and sealing are one action deliberately: a passkey with no bundle behind it
   * looks like protection while providing none.
   */
  const setUp = useMutation({
    mutationFn: async () => {
      const id = accountId as string;
      const passkey = await createTrustPasskey(id, user?.email ?? "spawn operator");
      if (!passkey.prfEnabled) {
        throw new PasskeyPrfError(
          "prf_unavailable",
          "this authenticator reported no PRF support, so it cannot unlock a trust bundle",
        );
      }
      await trust.addPasskey(passkey.credentialId, "this device");

      const secret = await evaluateTrustPrf(id, [passkey.credentialId]);
      const key = await deriveTrustBundleKey(secret, id);
      const { sealed, hostCount } = await sealCurrentTrust(key, { accountId: id });
      const existing = await trust.getBundle();
      await trust.putBundle(sealed, existing?.revision);
      return hostCount;
    },
    onMutate: begin,
    onSuccess: (hostCount) => {
      setStatus(
        `Passkey ready. ${hostCount} verified host${hostCount === 1 ? "" : "s"} sealed into your trust bundle.`,
      );
      queryClient.invalidateQueries({ queryKey: ["trust"] });
    },
    onError: (err) => setError(describe(err)),
  });

  /** Unlock on a device that has never been paired from a host terminal. */
  const unlock = useMutation({
    mutationFn: async () => {
      const id = accountId as string;
      const stored = await trust.getBundle();
      if (stored === null) {
        throw new Error(
          "No trust bundle has been sealed yet. Set one up on a paired device first.",
        );
      }
      const known = (await trust.listPasskeys()).map((row) => row.credential_id);
      const secret = await evaluateTrustPrf(id, known);
      const key = await deriveTrustBundleKey(secret, id);
      return importTrustBundle(key, stored.sealed, { accountId: id });
    },
    onMutate: begin,
    onSuccess: (result) => {
      setStatus(
        result.added.length === 0
          ? `Already up to date — ${result.alreadyTrusted.length} host${result.alreadyTrusted.length === 1 ? "" : "s"} already trusted on this device.`
          : `Imported ${result.added.length} host${result.added.length === 1 ? "" : "s"} onto this device.`,
      );
      queryClient.invalidateQueries({ queryKey: ["trust"] });
    },
    onError: (err) => setError(describe(err)),
  });

  const supported = isPasskeySupported();
  const busy = setUp.isPending || unlock.isPending;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle>Device trust</CardTitle>
          <CardDescription>
            Your verified host keys, sealed under a passkey so a new device can inherit them without
            pairing from a host terminal. The server stores only ciphertext and cannot read or forge
            it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!supported && (
            <p className="text-sm text-muted-foreground">
              This browser cannot use passkeys here. Passkeys need a secure context (HTTPS).
            </p>
          )}

          <div className="text-sm">
            <p>
              Hosts verified on this device:{" "}
              <span className="font-mono font-semibold" data-testid="local-pin-count">
                {localPins.data?.length ?? "…"}
              </span>
            </p>
            <p>
              Sealed bundle:{" "}
              <span className="font-mono font-semibold" data-testid="bundle-state">
                {bundle.isLoading
                  ? "…"
                  : bundle.data === null || bundle.data === undefined
                    ? "none"
                    : `revision ${bundle.data.revision}`}
              </span>
            </p>
            <p>
              Passkeys registered:{" "}
              <span className="font-mono font-semibold" data-testid="passkey-count">
                {passkeys.data?.length ?? "…"}
              </span>
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={!supported || busy || accountId === null}
              onClick={() => setUp.mutate()}
              data-testid="setup-passkey"
            >
              {setUp.isPending ? "Setting up…" : "Set up passkey and seal this device"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!supported || busy || accountId === null}
              onClick={() => unlock.mutate()}
              data-testid="unlock-trust"
            >
              {unlock.isPending ? "Unlocking…" : "Unlock trust on this device"}
            </Button>
          </div>

          {status !== null && (
            <p className="text-sm font-medium" data-testid="trust-status">
              {status}
            </p>
          )}
          {error !== null && (
            <p className="text-sm font-medium text-destructive" data-testid="trust-error">
              {error}
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            Sealing publishes only hosts you have actively verified; revoked hosts are never carried
            across. Importing pins those same keys here, which is safe because a bundle only opens
            with a secret held by your authenticator.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
