"use client";

import { Check, Copy, Wrench } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Host } from "@/lib/api";
import { hostHealthPanel } from "@/lib/host-health";
import { cn } from "@/lib/utils";

/** Copyable command shared by the host detail and fleet health surfaces. */
export function CopyCommand({ command, compact = false }: { command: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/40",
        compact ? "p-1.5" : "p-2",
      )}
    >
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-1 font-mono text-xs">
        {command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label={`Copy ${command}`}
        onClick={() => void copy()}
      >
        {copied ? (
          <Check className="size-3.5 text-success" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? `Copied ${command}` : ""}
      </span>
    </div>
  );
}

export function HostHealthPanel({ host, compact = false }: { host: Host; compact?: boolean }) {
  const state = hostHealthPanel(host);
  if (state.case === "online" || state.command === null) return null;

  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-muted/20",
        compact ? "space-y-2 p-3" : "space-y-3 p-4",
      )}
      aria-labelledby={compact ? undefined : "host-health-title"}
      data-health-case={state.case}
      data-testid="host-health-panel"
    >
      <div className="flex items-center gap-2">
        <Wrench className="size-4 text-muted-foreground" aria-hidden />
        <h2 id={compact ? undefined : "host-health-title"} className="text-sm font-medium">
          Something wrong?
        </h2>
      </div>
      <p className="text-xs leading-5 text-muted-foreground sm:text-sm">{state.message}</p>
      <CopyCommand command={state.command} compact={compact} />
    </section>
  );
}
