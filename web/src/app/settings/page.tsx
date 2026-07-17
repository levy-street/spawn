"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ApiError,
  type BrowserDevice,
  browserDevices,
  type Skill,
  type SkillCreateInput,
  skills as skillApi,
} from "@/lib/api";
import { logout, useAuth } from "@/lib/auth";
import { loadBrowserDeviceIdentity } from "@/lib/browser-device-identity";
import {
  allowExplicitBrowserIdentityReplacement,
  type BrowserDeviceRegistrationState,
  beginBrowserDeviceLocalCleanup,
  browserDeviceRegistrationQueryKey,
  finishBrowserDeviceLocalCleanup,
  useBrowserDeviceRegistration,
} from "@/lib/browser-device-registration";

export default function SettingsPage() {
  return (
    <AuthGate>
      <AppShell>
        <SettingsView />
      </AppShell>
    </AuthGate>
  );
}

function SettingsView() {
  const { user } = useAuth();
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4 @container/settings">
      <h1 className="text-xl font-semibold">Settings</h1>
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Signed in as {user?.email ?? "—"}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="secondary"
            onClick={() => {
              void logout();
            }}
          >
            Log out
          </Button>
        </CardContent>
      </Card>
      <BrowserDevicesSettings />
      <SkillsSettings />
      <Card>
        <CardHeader>
          <CardTitle>Danger zone</CardTitle>
          <CardDescription>Account deletion is not yet wired up.</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

function BrowserDevicesSettings() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const registration = useBrowserDeviceRegistration(user?.id);
  const devices = useQuery({
    queryKey: ["browser-devices"],
    queryFn: browserDevices.list,
    enabled: user !== null,
  });
  const localIdentity = useQuery({
    queryKey: ["browser-device-local-identity", user?.id],
    queryFn: () => loadBrowserDeviceIdentity(user!.id),
    enabled: user !== null,
    retry: false,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (registration.data?.status === "ready") {
      void qc.invalidateQueries({ queryKey: ["browser-devices"] });
    }
  }, [qc, registration.data?.status]);

  const currentPublicKey =
    registration.data?.publicKey ?? localIdentity.data?.publicKeyWire ?? null;
  const currentDevice =
    (devices.data ?? []).find((device) => device.public_key === currentPublicKey) ??
    (registration.data?.status === "ready" ? registration.data.device : undefined);

  const setRegistrationState = (state: BrowserDeviceRegistrationState) => {
    if (!user) return;
    qc.setQueryData(browserDeviceRegistrationQueryKey(user.id), state);
  };

  const revoke = useMutation({
    mutationFn: async (device: BrowserDevice) => {
      if (!user) throw new Error("not authenticated");
      const revoked = await browserDevices.revoke(device.id, device.public_key);
      if (
        revoked.id !== device.id ||
        revoked.public_key !== device.public_key ||
        revoked.revoked_at === null
      ) {
        throw new Error("Revocation response did not confirm the expected browser key");
      }
      if (device.public_key !== currentPublicKey) return revoked;

      // Disable identity-dependent actions in this tab immediately after the
      // server confirms revocation, even if durable local cleanup state cannot
      // be written or IndexedDB deletion fails below.
      setRegistrationState({ status: "cleanup_pending", publicKey: device.public_key });
      try {
        const localStatus = await beginBrowserDeviceLocalCleanup(user.id, device.public_key);
        setRegistrationState({ status: localStatus, publicKey: device.public_key });
        if (localStatus === "cleanup_pending") {
          await finishBrowserDeviceLocalCleanup(user.id, device.public_key);
          setRegistrationState({ status: "revoked", publicKey: device.public_key });
          qc.setQueryData(["browser-device-local-identity", user.id], null);
        }
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`Server revocation succeeded, but local key cleanup failed: ${detail}`);
      }
      return revoked;
    },
    onSuccess: () => setError(null),
    onError: (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["browser-devices"] }),
  });

  const retryCleanup = async (expectedPublicKey: string) => {
    if (!user) return;
    setError(null);
    try {
      await finishBrowserDeviceLocalCleanup(user.id, expectedPublicKey);
      setRegistrationState({ status: "revoked", publicKey: expectedPublicKey });
      qc.setQueryData(["browser-device-local-identity", user.id], null);
    } catch (cause) {
      setError(`Local key cleanup still failed: ${cause instanceof Error ? cause.message : cause}`);
    }
  };

  const recoverRevokedLocalKey = async (device: BrowserDevice) => {
    if (!user) return;
    setError(null);
    try {
      const status = await beginBrowserDeviceLocalCleanup(user.id, device.public_key);
      setRegistrationState({ status, publicKey: device.public_key });
      if (status === "cleanup_pending") await retryCleanup(device.public_key);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const createReplacement = () => {
    if (!user || registration.data?.status !== "revoked") return;
    setError(null);
    try {
      allowExplicitBrowserIdentityReplacement(user.id, registration.data.publicKey);
      void qc.invalidateQueries({ queryKey: browserDeviceRegistrationQueryKey(user.id) });
      void qc.invalidateQueries({ queryKey: ["browser-device-local-identity", user.id] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Browser identities</CardTitle>
        <CardDescription>
          Account-bound public keys for browsers you have used. Fingerprints are derived by the
          server; registration does not yet authenticate live host signaling.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-border p-3">
          <p className="text-sm font-medium">This browser</p>
          {currentDevice ? (
            <p className="mt-1 break-all font-mono text-xs" data-testid="browser-fingerprint">
              {currentDevice.fingerprint}
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              {registration.isError
                ? "Identity registration needs attention."
                : "No server-derived fingerprint is available."}
            </p>
          )}
          {registration.data?.status === "cleanup_pending" && (
            <div className="mt-3 space-y-2" role="alert">
              <p className="text-sm text-amber-700 dark:text-amber-300">
                Server revocation is complete. Local key deletion is still pending; a replacement
                will not be generated automatically.
              </p>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void retryCleanup(registration.data!.publicKey)}
              >
                Retry local key deletion
              </Button>
            </div>
          )}
          {registration.data?.status === "revoked" && (
            <div className="mt-3 space-y-2" role="status">
              <p className="text-sm">
                The server key is revoked and the local key is removed. Creating a replacement is an
                explicit new registration.
              </p>
              <Button size="sm" onClick={createReplacement}>
                Create replacement identity
              </Button>
            </div>
          )}
        </div>

        {(error || devices.error || localIdentity.error) && (
          <p className="text-sm text-destructive" role="alert">
            {error ??
              `Failed to load browser identities: ${String(devices.error ?? localIdentity.error)}`}
          </p>
        )}

        <div className="divide-y divide-border rounded-md border border-border">
          {devices.isLoading && (
            <div className="p-3 text-sm text-muted-foreground">Loading browser identities...</div>
          )}
          {!devices.isLoading && !devices.error && (devices.data?.length ?? 0) === 0 && (
            <div className="p-3 text-sm text-muted-foreground">No registered browsers.</div>
          )}
          {(devices.data ?? []).map((device) => {
            const isCurrent = device.public_key === currentPublicKey;
            return (
              <div key={device.id} className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{device.fingerprint}</span>
                    {isCurrent && (
                      <span className="rounded border border-border px-1.5 py-0.5 text-[11px]">
                        this browser
                      </span>
                    )}
                    {device.revoked_at && (
                      <span className="rounded border border-border px-1.5 py-0.5 text-[11px]">
                        revoked
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Registered {new Date(device.created_at).toLocaleDateString()}
                  </p>
                </div>
                {!device.revoked_at ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={revoke.isPending}
                    onClick={() => {
                      if (confirm(`Revoke browser ${device.fingerprint}?`)) revoke.mutate(device);
                    }}
                  >
                    Revoke
                  </Button>
                ) : isCurrent && registration.data?.status !== "revoked" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void recoverRevokedLocalKey(device)}
                  >
                    Remove local key
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function SkillsSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["skills"], queryFn: skillApi.list });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [enabledByDefault, setEnabledByDefault] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setName("");
    setDescription("");
    setContent("");
    setEnabledByDefault(false);
    setEditingId(null);
    setError(null);
  };

  const editSkill = (skill: Skill) => {
    setName(skill.name);
    setDescription(skill.description);
    setContent(skill.content);
    setEnabledByDefault(skill.enabled_by_default);
    setEditingId(skill.id);
    setError(null);
  };

  const createM = useMutation({
    mutationFn: skillApi.create,
    onSuccess: () => {
      resetForm();
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });
  const updateM = useMutation({
    mutationFn: ({ id, body }: { id: string; body: SkillCreateInput }) => skillApi.update(id, body),
    onSuccess: () => {
      resetForm();
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });
  const removeM = useMutation({
    mutationFn: skillApi.remove,
    onSuccess: (_, removedId) => {
      if (editingId === removedId) resetForm();
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (!content.trim()) {
      setError("Content is required.");
      return;
    }
    const body: SkillCreateInput = {
      name: name.trim(),
      description: description.trim(),
      content,
      enabled_by_default: enabledByDefault,
    };
    if (editingId) updateM.mutate({ id: editingId, body });
    else createM.mutate(body);
  };

  const busy = createM.isPending || updateM.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Skills</CardTitle>
        <CardDescription>Manage agent-accessible skills.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="grid gap-3 @md/settings:grid-cols-2" onSubmit={onSubmit}>
          <div className="space-y-1">
            <Label htmlFor="skill-name">Name</Label>
            <Input
              id="skill-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="skill-description">Description</Label>
            <Input
              id="skill-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-1 @md/settings:col-span-2">
            <Label htmlFor="skill-content">Content</Label>
            <Textarea
              id="skill-content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={8}
              disabled={busy}
            />
          </div>
          <label className="flex items-center gap-2 text-sm @md/settings:col-span-2">
            <input
              type="checkbox"
              checked={enabledByDefault}
              onChange={(event) => setEnabledByDefault(event.currentTarget.checked)}
              disabled={busy}
            />
            Grant to new agents by default
          </label>
          {(error || q.error) && (
            <p className="text-sm text-destructive @md/settings:col-span-2" role="alert">
              {error ?? `Failed to load skills: ${String(q.error)}`}
            </p>
          )}
          <div className="flex flex-wrap gap-2 @md/settings:col-span-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving..." : editingId ? "Update skill" : "Add skill"}
            </Button>
            {editingId && (
              <Button type="button" variant="secondary" onClick={resetForm} disabled={busy}>
                <X className="size-4" />
                Cancel
              </Button>
            )}
          </div>
        </form>
        <div className="divide-y divide-border rounded-md border border-border">
          {q.isLoading && (
            <div className="p-3 text-sm text-muted-foreground">Loading skills...</div>
          )}
          {!q.isLoading && !q.error && (q.data?.length ?? 0) === 0 && (
            <div className="p-3 text-sm text-muted-foreground">No skills yet.</div>
          )}
          {(q.data ?? []).map((skill) => (
            <div key={skill.id} className="flex items-start justify-between gap-3 p-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{skill.name}</span>
                  {skill.enabled_by_default && (
                    <span className="rounded border border-border px-1.5 py-0.5 text-[11px]">
                      default
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">{skill.description}</div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit skill ${skill.name}`}
                  title="Edit skill"
                  disabled={busy}
                  onClick={() => editSkill(skill)}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete skill ${skill.name}`}
                  title="Delete skill"
                  disabled={removeM.isPending}
                  onClick={() => {
                    if (confirm(`Delete skill ${skill.name}?`)) removeM.mutate(skill.id);
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
