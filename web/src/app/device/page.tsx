"use client";

import { type FormEvent, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, auth } from "@/lib/api";

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
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const r = await auth.approveDevice({ user_code: code.trim().toUpperCase() });
      setHostName(r.host_name);
      setCode("");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Approval failed";
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
          <form className="space-y-3" onSubmit={onSubmit}>
            <div className="space-y-1">
              <Label htmlFor="user_code">Device code</Label>
              <Input
                id="user_code"
                placeholder="QZ4K-7HMT"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
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
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Approving..." : "Approve daemon"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
