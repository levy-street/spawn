"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Agent identity icon: maps an agent definition `kind` (preferred) or a
 * running `command` to a bundled brand mark — Claude Code, Codex, OpenCode,
 * Aider — a terminal glyph for shells, or a monogram fallback. Used by the
 * sidebar session rows, pane headers, and the shortcut bar.
 *
 * Successor to `components/agents/AgentKindIcon.tsx`, which dies with the
 * old agents surface.
 */
const SHELL_RE = /^(bash|zsh|fish|sh|dash)$/;

export type ResolvedAgentIcon = {
  icon: "claude-code" | "codex" | "opencode" | "aider" | "shell" | "monogram";
  /** Tooltip / accessible name: brand name, shell name, or the raw input. */
  label: string;
  /** Monogram letter (only for `icon: "monogram"`). */
  letter?: string;
};

/** First non-`KEY=value` token of a command string, path stripped. */
function commandBasename(command: string): string {
  const token = command
    .trim()
    .split(/\s+/)
    .find((part) => part !== "" && !part.includes("="));
  return token?.split(/[\\/]/).at(-1) ?? "";
}

function matchName(name: string): ResolvedAgentIcon | null {
  const lower = name.toLowerCase();
  if (lower.includes("claude")) return { icon: "claude-code", label: "Claude Code" };
  if (lower.includes("codex")) return { icon: "codex", label: "Codex" };
  if (lower.includes("opencode")) return { icon: "opencode", label: "OpenCode" };
  if (lower.includes("aider")) return { icon: "aider", label: "Aider" };
  if (SHELL_RE.test(lower)) return { icon: "shell", label: lower };
  return null;
}

export function resolveAgentIcon(kind?: string | null, command?: string | null): ResolvedAgentIcon {
  const fromKind = kind?.trim() ? matchName(kind.trim()) : null;
  if (fromKind) return fromKind;
  const basename = command ? commandBasename(command) : "";
  const fromCommand = basename ? matchName(basename) : null;
  if (fromCommand) return fromCommand;
  const raw = kind?.trim() || basename;
  const letter = raw.match(/[a-z0-9]/i)?.[0]?.toUpperCase() ?? "?";
  return { icon: "monogram", label: raw || "Agent", letter };
}

const PLATE_CLASS: Record<ResolvedAgentIcon["icon"], string> = {
  // Brand plates are fixed constants like the grimoire palette — third-party
  // marks keep their identity in both themes.
  "claude-code": "bg-[#D97757] text-white ring-white/10",
  codex: "bg-white ring-black/10",
  opencode: "bg-black text-white ring-white/20",
  aider: "bg-[#10231b] text-[#3fcf8e] ring-white/10",
  shell: "bg-[#1c2128] text-[#7ee787] ring-white/10",
  monogram: "bg-muted text-muted-foreground ring-border",
};

export function AgentIcon({
  kind,
  command,
  size = 28,
  className,
}: {
  kind?: string | null;
  command?: string | null;
  size?: number;
  className?: string;
}) {
  const resolved = resolveAgentIcon(kind, command);
  const glyphSize = Math.round(size * 0.58);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg shadow-sm ring-1 ring-inset",
        PLATE_CLASS[resolved.icon],
        className,
      )}
      style={{ width: size, height: size }}
      role="img"
      title={resolved.label}
      aria-label={resolved.label}
    >
      {resolved.icon === "codex" ? (
        // The Codex mark ships its own white rounded plate — render it
        // full-bleed so the tile *is* the app icon.
        <CodexMark size={size} />
      ) : resolved.icon === "claude-code" ? (
        <ClaudeCodeMark size={glyphSize} />
      ) : resolved.icon === "opencode" ? (
        <OpenCodeMark size={glyphSize} />
      ) : resolved.icon === "aider" ? (
        <AiderMark size={glyphSize} />
      ) : resolved.icon === "shell" ? (
        <ShellMark size={glyphSize} />
      ) : (
        <span
          className="font-medium leading-none"
          style={{ fontSize: Math.max(10, Math.round(size * 0.45)) }}
          aria-hidden
        >
          {resolved.letter}
        </span>
      )}
    </span>
  );
}

function ClaudeCodeMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        clipRule="evenodd"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}

function CodexMark({ size }: { size: number }) {
  const gradientId = useId().replaceAll(":", "_");
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z"
        fill="#fff"
      />
      <path
        d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
        fill={`url(#${gradientId})`}
      />
      <defs>
        <linearGradient
          id={gradientId}
          x1="4.33"
          x2="19.5"
          y1="18.25"
          y2="5"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#B1A7FF" />
          <stop offset=".5" stopColor="#7A9DFF" />
          <stop offset="1" stopColor="#3941FF" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function OpenCodeMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M16 6H8v12h8V6zm4 16H4V2h16v20z" fill="currentColor" />
    </svg>
  );
}

function AiderMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M5 19 12 5l7 14M8.3 14.4h7.4"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ShellMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4.5 6 10 12l-5.5 6M13 19h6.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
