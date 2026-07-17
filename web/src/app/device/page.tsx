"use client";

import { type FormEvent, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, auth, type DeviceApproval } from "@/lib/api";

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
  const [code, setCode] = useState("");
  const [hostName, setHostName] = useState<string | null>(null);
  const [pending, setPending] = useState<DeviceApproval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onReview = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const r = await auth.pendingDevice({ user_code: code.trim().toUpperCase() });
      setPending(r);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Approval failed";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const onApprove = async () => {
    if (!pending) return;
    setError(null);
    setSubmitting(true);
    try {
      const r = await auth.approveDevice({
        user_code: code.trim().toUpperCase(),
        host_key_algorithm: pending.host_key_algorithm,
        host_public_key: pending.host_public_key,
        host_key_fingerprint: pending.host_key_fingerprint,
      });
      setHostName(r.host_name);
      setPending(null);
      setCode("");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Approval failed";
      setError(message);
      setPending(null);
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
                <div className="flex gap-2">
                  <Button
                    type="button"
                    className="flex-1"
                    disabled={submitting}
                    onClick={onApprove}
                  >
                    {submitting ? "Approving..." : "Confirm approval"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={submitting}
                    onClick={() => setPending(null)}
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
