"use client";

/**
 * Shared presentational primitives for the trust UX.
 * Basic Tailwind only: spacing, hierarchy, borders. No visual-design investment.
 */

import { type FormEvent, type ReactNode, useState } from "react";

export type Tone = "ok" | "warn" | "danger" | "neutral";

const pillTone: Record<Tone, string> = {
  ok: "border-green-600 text-green-700",
  warn: "border-amber-600 text-amber-700",
  danger: "border-red-600 text-red-700",
  neutral: "border-neutral-400 text-neutral-600",
};

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-xs whitespace-nowrap ${pillTone[tone]}`}
    >
      {children}
    </span>
  );
}

const dotTone: Record<Tone, string> = {
  ok: "bg-green-500",
  warn: "bg-amber-500",
  danger: "bg-red-500",
  neutral: "bg-neutral-400",
};

export function Dot({ tone }: { tone: Tone }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${dotTone[tone]}`} />;
}

type BtnKind = "primary" | "quiet" | "danger" | "danger-quiet";

const btnKind: Record<BtnKind, string> = {
  primary: "bg-neutral-900 text-white border-neutral-900 hover:bg-neutral-700",
  quiet: "bg-white text-neutral-800 border-neutral-300 hover:bg-neutral-100",
  danger: "bg-red-700 text-white border-red-700 hover:bg-red-600",
  "danger-quiet": "bg-white text-red-700 border-red-300 hover:bg-red-50",
};

export function Btn({
  kind = "quiet",
  onClick,
  disabled,
  children,
  submit,
}: {
  kind?: BtnKind;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  submit?: boolean;
}) {
  return (
    <button
      type={submit ? "submit" : "button"}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-3 py-1.5 text-sm disabled:opacity-40 ${btnKind[kind]}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, tone }: { children: ReactNode; tone?: Tone }) {
  const border =
    tone === "danger"
      ? "border-red-300"
      : tone === "warn"
        ? "border-amber-300"
        : "border-neutral-200";
  return <div className={`rounded-lg border bg-white p-4 ${border}`}>{children}</div>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-base font-semibold text-neutral-900">{children}</h2>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="text-sm text-neutral-500">{children}</p>;
}

export function Spinner() {
  return (
    <span
      role="status"
      aria-label="Working"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-800 align-middle"
    />
  );
}

/** The 6-digit match code, displayed "NNN NNN", large. */
export function MatchCode({ code }: { code: string }) {
  const digits = code.replace(/\D/g, "");
  const shown = digits.length === 6 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : code;
  return (
    <div className="rounded-lg border border-neutral-300 bg-neutral-50 px-6 py-4 text-center font-mono text-4xl tracking-[0.3em] text-neutral-900">
      {shown}
    </div>
  );
}

/**
 * Entry side of the number match (A5: entry-style, never tap-to-approve).
 * Local input state only; the ceremony state machine lives in props of the parent.
 */
export function CodeEntry({
  otherSideLabel,
  attemptsRemaining,
  wrongEntry,
  disabled,
  onSubmitCode,
  onReportMismatch,
}: {
  /** Names the screen the code is shown on, e.g. `the terminal on "atlas"`. */
  otherSideLabel: string;
  attemptsRemaining: number;
  wrongEntry: boolean;
  disabled?: boolean;
  onSubmitCode: (code: string) => void;
  onReportMismatch: () => void;
}) {
  const [value, setValue] = useState("");
  const digits = value.replace(/\D/g, "").slice(0, 6);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (digits.length === 6) onSubmitCode(digits);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <label className="block text-sm text-neutral-700">
        Enter the code shown on {otherSideLabel}.
        <input
          value={digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits}
          onChange={(e) => setValue(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000 000"
          disabled={disabled}
          className="mt-2 block w-full rounded-md border border-neutral-300 px-3 py-2 text-center font-mono text-2xl tracking-widest disabled:opacity-40"
        />
      </label>
      {wrongEntry ? (
        <p className="text-sm text-amber-700">
          That doesn&apos;t match. Check the two screens carefully — if they show different codes,
          stop. {attemptsRemaining} {attemptsRemaining === 1 ? "attempt" : "attempts"} left.
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <Btn submit kind="primary" disabled={disabled || digits.length !== 6}>
          Verify
        </Btn>
        <Btn kind="danger-quiet" onClick={onReportMismatch} disabled={disabled}>
          The codes don&apos;t match
        </Btn>
      </div>
    </form>
  );
}

/** Shared terminal outcome cards for ceremonies. */
export function CeremonyOutcome({
  tone,
  title,
  body,
  actions,
}: {
  tone: Tone;
  title: string;
  body: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Card tone={tone}>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Dot tone={tone} />
          <h3 className="font-semibold text-neutral-900">{title}</h3>
        </div>
        <div className="text-sm text-neutral-700">{body}</div>
        {actions ? <div className="flex gap-2 pt-1">{actions}</div> : null}
      </div>
    </Card>
  );
}
