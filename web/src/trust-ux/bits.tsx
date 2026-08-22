"use client";

import type { ReactNode, SVGProps } from "react";

/* ---------- buttons ---------- */

type ButtonVariant = "primary" | "subtle" | "danger" | "ghost";

const buttonStyles: Record<ButtonVariant, string> = {
  primary: "bg-zinc-100 text-zinc-900 hover:bg-white",
  subtle: "bg-zinc-800/80 text-zinc-200 hover:bg-zinc-700/80",
  danger: "border border-red-500/20 bg-red-500/10 text-red-400 hover:bg-red-500/20",
  ghost: "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60",
};

export function Button({
  variant = "primary",
  full = false,
  onClick,
  children,
}: {
  variant?: ButtonVariant;
  full?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors ${buttonStyles[variant]} ${full ? "w-full" : ""}`}
    >
      {children}
    </button>
  );
}

export function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800/70 hover:text-zinc-200"
    >
      {children}
    </button>
  );
}

/* ---------- small pieces ---------- */

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <div
      className={`size-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300 ${className}`}
      role="status"
      aria-label="Working"
    />
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 whitespace-nowrap rounded-full bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
      {children}
    </span>
  );
}

/** The small label naming what a flow screen is for. Sentence case — names live here. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-xs font-medium tracking-wide text-zinc-500">{children}</p>;
}

/** The screen card every flow lives in. */
export function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[420px] w-[340px] max-w-full flex-col rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 shadow-xl shadow-black/20">
      {children}
    </div>
  );
}

/** An opened row menu (the host app positions it). */
export function Menu({ children }: { children: ReactNode }) {
  return (
    <div
      role="menu"
      className="w-40 rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-2xl shadow-black/50"
    >
      {children}
    </div>
  );
}

export function MenuItem({
  danger = false,
  onClick,
  children,
}: {
  danger?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`block w-full px-3.5 py-2 text-left text-sm transition-colors ${
        danger ? "text-red-400 hover:bg-red-500/10" : "text-zinc-200 hover:bg-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}

/** A modal card (rendered inline; the host app supplies the backdrop). */
export function DialogCard({ children }: { children: ReactNode }) {
  return (
    <div className="w-[340px] max-w-full rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl shadow-black/40">
      {children}
    </div>
  );
}

/* ---------- icons (inline, stroke = currentColor) ---------- */

function Svg({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-[18px]"
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconPhone(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M12 18h.01" />
    </Svg>
  );
}

export function IconLaptop(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="4" y="5" width="16" height="11" rx="2" />
      <path d="M2 19h20" />
    </Svg>
  );
}

export function IconComputer(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </Svg>
  );
}

export function IconKey(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M2.6 17.4A2 2 0 0 0 2 18.8V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.2a2 2 0 0 0 1.4-.6l.8-.8a6.5 6.5 0 1 0-4-4Z" />
      <circle cx="16.5" cy="7.5" r="0.5" />
    </Svg>
  );
}

export function IconCheck(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="m4 12.5 5 5L20 6.5" />
    </Svg>
  );
}

export function IconAlert(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Svg>
  );
}

export function IconBlocked(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.7 5.7 12.6 12.6" />
    </Svg>
  );
}

export function IconEllipsis(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="12" r="0.6" />
      <circle cx="12" cy="12" r="0.6" />
      <circle cx="19" cy="12" r="0.6" />
    </Svg>
  );
}

export function IconPlus(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Svg>
  );
}

export function IconChevronRight(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="m9 6 6 6-6 6" />
    </Svg>
  );
}
