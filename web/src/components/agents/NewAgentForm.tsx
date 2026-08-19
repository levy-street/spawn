"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { KindIcon } from "@/components/agents/AgentKindIcon";
import { DirectoryPicker } from "@/components/agents/DirectoryPicker";
import { YoloBadge } from "@/components/agents/YoloBadge";
import { HostGpuBadge } from "@/components/hosts/HostGpuBadge";
import { HostOsIcon, hostOsLabel } from "@/components/hosts/HostOsIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { hostStatusTone, StatusDot } from "@/components/ui/status";
import { useHostControl } from "@/hooks/useHostControl";
import type { AgentKind } from "@/lib/agents";
import { ApiError, agents, hosts, presets, screens, skills as skillApi } from "@/lib/api";
import { normalizeCommandText, parseArgv } from "@/lib/argv";
import { insertAtEdge } from "@/lib/layout";
import { normalizeCwdForHost, withTrailingSlash } from "@/lib/paths";
import { cn } from "@/lib/utils";

const PRESET_ORDER = ["codex", "claude-code", "opencode", "aider-sonnet", "shell"];
const YOLO_STORAGE_KEY = "spawn.newAgent.yolo";

function kindForPreset(agentKind: string): AgentKind {
  const kind = agentKind.toLowerCase();
  if (kind.includes("codex")) return "codex";
  if (kind.includes("claude")) return "claude";
  if (kind.includes("opencode")) return "opencode";
  if (kind.includes("aider")) return "aider";
  if (kind.includes("shell")) return "shell";
  return "custom";
}

export function NewAgentForm({
  initialHostId,
  intoScreenId,
}: {
  initialHostId?: string;
  intoScreenId?: string;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list });
  const presetsQ = useQuery({ queryKey: ["presets"], queryFn: presets.list });
  const skillsQ = useQuery({ queryKey: ["skills"], queryFn: skillApi.list });

  const [hostId, setHostId] = useState(initialHostId ?? "");
  const [name, setName] = useState("");
  const [presetId, setPresetId] = useState("");
  const [cwd, setCwd] = useState("");
  const [argv, setArgv] = useState("");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  // Remembered per browser rather than per account: it is a habit, and the
  // people who want it want it every time.
  const [yolo, setYolo] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAutoCwd, setLastAutoCwd] = useState("");
  const [presetTouched, setPresetTouched] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(YOLO_STORAGE_KEY);
    if (stored !== null) setYolo(stored === "true");
  }, []);
  const { client: hostControl, state: hostControlState } = useHostControl(hostId || null);
  const homeQ = useQuery({
    queryKey: ["host-home", hostId],
    queryFn: () => hostControl!.home(),
    enabled: hostControlState === "ready" && hostControl !== null,
  });

  const m = useMutation({
    mutationFn: agents.create,
    onSuccess: async (created) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["hosts"] });
      // Born into a screen: append the new agent as a pane and land there
      // with it focused, instead of the standalone agent page.
      if (intoScreenId) {
        try {
          const target = await screens.get(intoScreenId);
          const nextRoot = insertAtEdge(target.layout.root ?? null, null, "right", created.id);
          await screens.update(intoScreenId, { layout: { root: nextRoot } });
          qc.invalidateQueries({ queryKey: ["screens"] });
          qc.invalidateQueries({ queryKey: ["screen", intoScreenId] });
          router.push(`/screens/${intoScreenId}?focus=${created.id}`);
          return;
        } catch {
          // Fall through to the agent page if the screen vanished.
        }
      }
      router.push(`/agents/${created.id}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const hostOptions = useMemo(
    () =>
      [...(hostsQ.data ?? [])].sort((a, b) => {
        if (a.status !== b.status) return a.status === "online" ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [hostsQ.data],
  );
  const presetOptions = useMemo(
    () =>
      [...(presetsQ.data ?? [])].sort((a, b) => {
        const ai = PRESET_ORDER.indexOf(a.name);
        const bi = PRESET_ORDER.indexOf(b.name);
        if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        return a.name.localeCompare(b.name);
      }),
    [presetsQ.data],
  );
  const selectedHost = hostOptions.find((h) => h.id === hostId);
  const selectedHostHomeDir = homeQ.data?.home_dir;
  const selectedPreset = presetOptions.find((p) => p.id === presetId);
  const customArgv = argv.trim().length > 0;
  // Only offered when the selected tool actually has a flag for it, and never
  // alongside a hand-written command — a toggle that silently does nothing is
  // worse than no toggle.
  const yoloAvailable = Boolean(selectedPreset?.yolo_argv?.length) && !customArgv;
  const composedArgv = selectedPreset
    ? [
        ...selectedPreset.default_argv,
        ...(yolo && yoloAvailable
          ? (selectedPreset.yolo_argv ?? []).filter(
              (flag) => !selectedPreset.default_argv.includes(flag),
            )
          : []),
      ]
    : [];
  const skillOptions = skillsQ.data ?? [];

  useEffect(() => {
    if (hostId || hostOptions.length === 0) return;
    setHostId((hostOptions.find((h) => h.status === "online") ?? hostOptions[0]).id);
  }, [hostId, hostOptions]);

  useEffect(() => {
    if (presetTouched || presetId || argv.trim() || presetOptions.length === 0) return;
    setPresetId((presetOptions.find((p) => p.name === "codex") ?? presetOptions[0]).id);
  }, [argv, presetId, presetOptions, presetTouched]);

  useEffect(() => {
    setSkillIds((current) => mergeDefaults(current, skillOptions));
  }, [skillOptions]);

  useEffect(() => {
    if (!hostId) return;
    if (!selectedHostHomeDir) return;
    const nextCwd = withTrailingSlash(selectedHostHomeDir.trim());
    if (!cwd.trim() || cwd === lastAutoCwd) {
      setCwd(nextCwd);
      setLastAutoCwd(nextCwd);
    }
  }, [cwd, hostId, lastAutoCwd, selectedHostHomeDir]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!hostId) {
      setError("Choose a host.");
      return;
    }
    if (!selectedHostHomeDir) {
      setError("Connect to the host before choosing a directory.");
      return;
    }
    let argvArr: string[] | undefined;
    try {
      argvArr = argv.trim() ? parseArgv(argv) : undefined;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not parse argv.");
      return;
    }
    if (!presetId && !argvArr) {
      setError("Choose an agent or provide a custom command.");
      return;
    }
    m.mutate({
      name: normalizeCommandText(name).trim() || undefined,
      host_id: hostId,
      preset_id: presetId || undefined,
      cwd: normalizeCwdForHost(cwd, selectedHostHomeDir),
      argv: argvArr,
      yolo: yolo && yoloAvailable,
      skill_ids: skillIds,
      create_cwd: true,
    });
  };

  const disabled = m.isPending;

  return (
    <form className="space-y-6" onSubmit={onSubmit} aria-describedby="new-agent-status">
      {/* Host */}
      <section className="space-y-2">
        <Label>Host</Label>
        {hostsQ.isLoading && <p className="text-sm text-muted-foreground">Loading hosts...</p>}
        {!hostsQ.isLoading && hostOptions.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No hosts connected yet — install the daemon from the download page first.
          </p>
        )}
        <div className="grid gap-2 @sm/form:grid-cols-2">
          {hostOptions.map((h) => {
            const selected = h.id === hostId;
            return (
              <button
                key={h.id}
                type="button"
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => setHostId(h.id)}
                className={cn(
                  "flex items-center gap-3 rounded-xl border p-3 text-left transition-colors",
                  selected
                    ? "border-ring bg-accent/60"
                    : "border-border hover:border-ring/50 hover:bg-accent/30",
                )}
              >
                <span className="relative grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-muted/50 text-muted-foreground">
                  <HostOsIcon os={h.os} />
                  <StatusDot
                    tone={hostStatusTone(h.status)}
                    label={h.status}
                    className="absolute -bottom-0.5 -right-0.5 border border-card"
                  />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{h.name}</span>
                    {/* The reason to pick one box over another is usually
                        right here: which OS it is, and whether it has a GPU. */}
                    <HostGpuBadge gpu={h.gpu} />
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {hostOsLabel(h.os)} · {h.status}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Agent preset */}
      <section className="space-y-2">
        <Label>Agent</Label>
        <div className="flex flex-wrap gap-2">
          {presetOptions.map((p) => {
            const selected = p.id === presetId;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => {
                  setPresetTouched(true);
                  setPresetId(selected ? "" : p.id);
                }}
                className={cn(
                  "flex items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3 text-sm transition-colors",
                  selected
                    ? "border-ring bg-accent/60"
                    : "border-border text-muted-foreground hover:border-ring/50 hover:bg-accent/30 hover:text-foreground",
                )}
              >
                <KindIcon kind={kindForPreset(p.agent_kind)} className="size-6 rounded-full" />
                {p.name}
              </button>
            );
          })}
        </div>
        {selectedPreset ? (
          <p className="text-xs text-muted-foreground">
            {/* The exact command, flag included, stays visible before you
                spawn — the toggle must never be the only place it is said. */}
            Runs <code className="text-foreground">{composedArgv.join(" ")}</code>
            {selectedPreset.install && <> — installed automatically when missing</>}.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            No preset selected — provide a custom command under advanced options.
          </p>
        )}

        {yoloAvailable && (
          <label
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors",
              yolo ? "border-ring bg-accent/40" : "border-border hover:border-ring/50",
            )}
          >
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--color-primary)]"
              checked={yolo}
              disabled={disabled}
              onChange={(e) => {
                setYolo(e.target.checked);
                window.localStorage.setItem(YOLO_STORAGE_KEY, String(e.target.checked));
              }}
            />
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-sm font-medium">
                YOLO mode
                <YoloBadge />
              </span>
              <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                Adds{" "}
                <code className="text-foreground">
                  {(selectedPreset?.yolo_argv ?? []).join(" ")}
                </code>{" "}
                so the agent does not stop to ask before it acts. Each tool means something slightly
                different by it — {selectedPreset?.name} decides what that covers, not spawn. It
                runs unattended inside a host you have already possessed, so anything the agent
                reads — a repo, an issue, a web page — is acting on your machine.
              </span>
            </span>
          </label>
        )}
      </section>

      {/* Directory */}
      <section className="@container/form">
        <DirectoryPicker
          host={selectedHost}
          value={cwd}
          onChange={(next) => {
            setCwd(next);
            if (next !== lastAutoCwd) setLastAutoCwd("");
          }}
          disabled={disabled}
        />
      </section>

      {/* Name */}
      <section className="space-y-1.5">
        <Label htmlFor="agent-name">Name</Label>
        <Input
          id="agent-name"
          placeholder="optional — defaults to host + folder"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          disabled={disabled}
        />
      </section>

      {/* Skills */}
      {skillOptions.length > 0 && (
        <section className="space-y-2">
          <Label>Skills</Label>
          <div className="flex flex-wrap gap-2">
            {skillOptions.map((skill) => {
              const checked = skillIds.includes(skill.id);
              return (
                <button
                  key={skill.id}
                  type="button"
                  aria-pressed={checked}
                  disabled={disabled}
                  title={skill.description}
                  onClick={() => setSkillIds((current) => toggleId(current, skill.id, !checked))}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-sm transition-colors",
                    checked
                      ? "border-ring bg-accent/60"
                      : "border-border text-muted-foreground hover:border-ring/50 hover:text-foreground",
                  )}
                >
                  {skill.name}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Advanced */}
      <section>
        <button
          type="button"
          className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          <ChevronDown
            className={cn("size-4 transition-transform duration-200", showAdvanced && "rotate-180")}
            aria-hidden
          />
          Advanced options
        </button>
        {showAdvanced && (
          <div className="mt-3 grid gap-4 rounded-xl border border-border p-4 @sm/form:grid-cols-2 animate-in fade-in-0 slide-in-from-top-1 duration-150">
            <div className="space-y-1.5 @sm/form:col-span-2">
              <Label htmlFor="agent-argv">Custom command</Label>
              <Input
                id="agent-argv"
                placeholder={selectedPreset ? "(use preset)" : "codex --yolo"}
                value={argv}
                onChange={(e) => setArgv(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                className="font-mono"
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">
                Overrides the preset command when set.
              </p>
            </div>
          </div>
        )}
      </section>

      {(hostsQ.error || presetsQ.error || error) && (
        <p id="new-agent-status" className="text-sm text-destructive" role="alert">
          {error ??
            (hostsQ.error
              ? `Failed to load hosts: ${String(hostsQ.error)}`
              : `Failed to load presets: ${String(presetsQ.error)}`)}
        </p>
      )}

      <div className="sticky bottom-0 -mx-1 flex items-center gap-2 border-t border-border bg-background/95 px-1 py-3 backdrop-blur @md/shell:static @md/shell:border-0 @md/shell:bg-transparent @md/shell:p-0">
        <Button type="submit" disabled={disabled || hostsQ.isLoading}>
          {m.isPending ? "Spawning..." : "Spawn agent"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={disabled}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function mergeDefaults<T extends { id: string; enabled_by_default: boolean }>(
  current: string[],
  options: T[],
): string[] {
  const available = new Set(options.map((option) => option.id));
  const next = current.filter((id) => available.has(id));
  for (const option of options) {
    if (option.enabled_by_default && !next.includes(option.id)) next.push(option.id);
  }
  return next;
}

function toggleId(current: string[], id: string, enabled: boolean): string[] {
  if (enabled) return current.includes(id) ? current : [...current, id];
  return current.filter((value) => value !== id);
}
