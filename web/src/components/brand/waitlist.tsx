"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import { CTA_SLAB } from "@/components/brand/press";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { waitlist } from "@/lib/api";
import { useAuthConfig } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { joinFailureMessage, looksLikeEmail, WAITLIST } from "@/lib/waitlist";

/**
 * The waitlist form: an address in, a place in line out.
 *
 * `plate` is the pressroom setting — the bone slab beside a dark field, for
 * the landing page and the SEO pages' Start block. `shell` is the auth
 * shell's own field and button, for the signup page.
 */
export function WaitlistForm({
  source,
  tone = "plate",
  align = "start",
  showBody = true,
  className,
}: {
  /** Where the address was left; defaults to the page's path. */
  source?: string;
  tone?: "plate" | "shell";
  align?: "start" | "center";
  /** The invite-only line above the field. Off where the shell says it already. */
  showBody?: boolean;
  className?: string;
}) {
  const pathname = usePathname();
  const fieldId = useId();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "submitting" | "joined">("idle");
  const [error, setError] = useState<string | null>(null);
  const submitting = state === "submitting";
  const centered = align === "center";

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!looksLikeEmail(address)) {
      setError(WAITLIST.invalid);
      return;
    }
    setError(null);
    setState("submitting");
    try {
      await waitlist.join({ email: address, source: source ?? pathname ?? null });
      setState("joined");
    } catch (cause) {
      setError(joinFailureMessage(cause));
      setState("idle");
    }
  };

  if (state === "joined") {
    return (
      <div
        role="status"
        data-testid="waitlist-joined"
        className={cn(centered && "text-center", className)}
      >
        <p
          className={
            tone === "plate"
              ? "font-sigil text-[13px] font-medium tracking-[0.14em] text-bone uppercase"
              : "text-sm font-medium"
          }
        >
          {WAITLIST.joinedTitle}
        </p>
        <p
          className={
            tone === "plate"
              ? "mt-3 text-[15px] leading-7 text-ash"
              : "mt-1 text-sm leading-6 text-muted-foreground"
          }
        >
          {WAITLIST.joined(email.trim())}
        </p>
      </div>
    );
  }

  if (tone === "shell") {
    return (
      <form className={cn("space-y-5", className)} onSubmit={onSubmit} noValidate>
        {showBody ? <p className="text-sm leading-6 text-ash">{WAITLIST.body}</p> : null}
        <div className="space-y-2">
          <Label htmlFor={fieldId}>{WAITLIST.emailLabel}</Label>
          <Input
            id={fieldId}
            className="h-11"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={submitting}
          />
        </div>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="h-11 w-full" disabled={submitting}>
          {submitting ? WAITLIST.submitting : WAITLIST.submit}
        </Button>
      </form>
    );
  }

  return (
    <form
      className={cn("w-full", className)}
      onSubmit={onSubmit}
      noValidate
      data-testid="waitlist-form"
    >
      {showBody ? (
        <p
          className={cn(
            "mb-5 max-w-[52ch] text-[15px] leading-7 text-ash",
            centered && "mx-auto text-center",
          )}
        >
          {WAITLIST.body}
        </p>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor={fieldId} className="sr-only">
          {WAITLIST.emailLabel}
        </label>
        <input
          id={fieldId}
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
          className="h-12 w-full min-w-0 rounded-sm border border-bone/25 sm:flex-1 bg-transparent px-4 text-[15px] text-bone transition-colors placeholder:text-ash focus:border-bone focus:outline-none disabled:opacity-60"
        />
        <button type="submit" className={CTA_SLAB} disabled={submitting}>
          {submitting ? WAITLIST.submitting : WAITLIST.submit}
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>
      {error ? (
        <p className={cn("mt-3 text-sm text-ember", centered && "text-center")} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * The page's one ask. While signup is closed that is the waitlist; once the
 * deployment opens it is the door. The static page is rendered closed — true
 * today — and an open deployment swaps the door in on the client, so the
 * answer is the server's, never the build's.
 */
export function StartAction({
  source,
  align = "start",
  className,
}: {
  source?: string;
  align?: "start" | "center";
  className?: string;
}) {
  const { config } = useAuthConfig();
  // Read after mount: the config query's cached placeholder is in
  // localStorage, and reading it during render would draw a different first
  // frame from the one the HTML carries.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const closed = mounted ? (config?.invite_only ?? true) : true;

  if (!closed) {
    return (
      <div className={cn(align === "center" && "flex justify-center", className)}>
        <Link prefetch={false} href="/signup" className={CTA_SLAB}>
          Sign up free
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    );
  }
  return <WaitlistForm source={source} tone="plate" align={align} className={className} />;
}
