"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Mail, RotateCw } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectHostSection } from "@/components/hosts/connect-host";
import { Button } from "@/components/ui/button";
import { PaceBar } from "@/components/ui/pace-bar";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, auth, type Host, hosts, type User } from "@/lib/api";
import { useAuth, useAuthConfig } from "@/lib/auth";
import { restoreDeviceApproval } from "@/lib/device-approval-stash";
import { AuthShell } from "./auth-shell";
import { SignupForm } from "./signup-form";
import { ONBOARDING_STEPS, type OnboardingStep, resolveStep } from "./step-machine";

const SUCCESS_BEAT_MS = 900;

type SuccessBeat = "verify" | "host" | null;
type CompletionState =
  | { status: "working" }
  | { status: "success"; message: string }
  | { status: "failed"; message: string };

const STEP_COPY: Record<OnboardingStep, { title: string; description: string }> = {
  account: {
    title: "Create your account",
    description: "One account keeps every host and workspace within reach.",
  },
  verify: {
    title: "Check your inbox",
    description: "Confirm this address before connecting a machine.",
  },
  host: {
    title: "Connect your first host",
    description:
      "Install the daemon on a Mac or Linux machine, then approve it from the link its terminal prints.",
  },
  done: {
    title: "Your machine is possessed",
    description: "Pick a folder on it and summon your first wall of terminals.",
  },
};

export function OnboardingFlow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const authState = useAuth();
  const configState = useAuthConfig();
  const [storage, setStorage] = useState({ ready: false });
  const _userId = authState.user?.id ?? null;
  // An approval link that went through signup leaves its ceremony in
  // sessionStorage. Claiming it here puts `?ref=…#k=…` back on this URL so the
  // host step can finish the approval in place.
  const [approvalFromLink, setApprovalFromLink] = useState(false);
  // Whether the stash has been looked for yet. The restore must happen in an
  // effect — it writes history and consumes storage — so rendering the host
  // step before it runs shows the install-and-type-a-code layout for a frame
  // and then replaces it: a flash of exactly the screen this flow exists to
  // skip. Holding the step for that tick is cheaper than showing it.
  const [approvalChecked, setApprovalChecked] = useState(false);

  useEffect(() => {
    const restored = restoreDeviceApproval(
      window.sessionStorage,
      window.location.href,
      Date.now(),
      ["/onboarding"],
    );
    if (restored !== null) {
      window.history.replaceState(window.history.state, "", restored);
      setApprovalFromLink(true);
    }
    setApprovalChecked(true);
  }, []);
  const [successBeat, setSuccessBeat] = useState<SuccessBeat>(null);
  const [completion, setCompletion] = useState<CompletionState>({ status: "working" });
  const successTimerRef = useRef<number | null>(null);
  const completionStartedRef = useRef(false);
  const mountedRef = useRef(true);
  const previousStepRef = useRef<OnboardingStep | null>(null);

  // Re-read whenever the signed-in account changes: the answer belongs to the
  // user, not the browser.
  useEffect(() => {
    setStorage({ ready: true });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (successTimerRef.current !== null) {
        window.clearTimeout(successTimerRef.current);
        successTimerRef.current = null;
      }
    };
  }, []);

  const config = configState.config;
  const user = authState.user;
  const verificationSatisfied =
    user !== null &&
    config !== null &&
    (!config.email_verification_required || user.email_verified_at !== null);

  const hostsQuery = useQuery({
    queryKey: ["hosts"],
    queryFn: hosts.list,
    enabled: verificationSatisfied,
    retry: 1,
    staleTime: 3_000,
    // Deliberately not polled. ConnectHostSection below polls for the host and
    // owns the moment it arrives: it paints its last checklist row complete,
    // then calls `onHostOnline` a beat later, and that callback is what moves
    // this page on. A poll here would race it — this page would learn the host
    // was online first and swap the whole surface for the success beat while
    // its last row still read "Connecting…", so the reader never sees the
    // thing they were waiting for tick over.
    //
    // The reload case needs no poll either: this query runs on mount, so a
    // machine that is already online when the page opens resolves straight to
    // "done" without the host step ever rendering.
  });

  const canDeriveStep =
    !authState.loading &&
    config !== null &&
    (user === null ||
      !verificationSatisfied ||
      (storage.ready && hostsQuery.data !== undefined && !hostsQuery.isError));

  const step = canDeriveStep
    ? resolveStep(
        {
          user,
          config,
          hosts: hostsQuery.data ?? [],
        },
        searchParams.get("step"),
      )
    : null;

  const playSuccessBeat = useCallback((beat: Exclude<SuccessBeat, null>) => {
    if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current);
    setSuccessBeat(beat);
    successTimerRef.current = window.setTimeout(() => {
      setSuccessBeat(null);
      successTimerRef.current = null;
    }, SUCCESS_BEAT_MS);
  }, []);

  useEffect(() => {
    if (step !== "verify" || user?.email_verified_at !== null) return;

    const poll = async () => {
      try {
        const result = await auth.me();
        if (result.user.email_verified_at === null) return;
        playSuccessBeat("verify");
        queryClient.setQueryData(["me"], result);
      } catch {
        // A transient poll failure should not replace the useful verify state.
      }
    };

    const timer = window.setInterval(() => void poll(), 5_000);
    return () => window.clearInterval(timer);
  }, [playSuccessBeat, queryClient, step, user?.email_verified_at]);

  const onHostOnline = useCallback(
    (host: Host) => {
      playSuccessBeat("host");
      queryClient.setQueryData<Host[]>(["hosts"], (current = []) => {
        const existingIndex = current.findIndex((candidate) => candidate.id === host.id);
        if (existingIndex === -1) return [...current, host];
        return current.map((candidate, index) => (index === existingIndex ? host : candidate));
      });
    },
    [playSuccessBeat, queryClient],
  );

  const onlineHost = hostsQuery.data?.find((host) => host.status === "online") ?? null;
  const approvedOfflineHost = hostsQuery.data?.find((host) => host.status !== "online") ?? null;
  const discoveredVerification =
    previousStepRef.current === "verify" &&
    step !== "verify" &&
    user?.email_verified_at !== null &&
    user?.email_verified_at !== undefined;
  const discoveredHost =
    previousStepRef.current === "host" && step === "done" && onlineHost !== null;
  const transitionBeat: SuccessBeat =
    successBeat ?? (discoveredVerification ? "verify" : discoveredHost ? "host" : null);

  useEffect(() => {
    if (step === null) return;
    if (successBeat === null) {
      if (discoveredVerification) playSuccessBeat("verify");
      else if (discoveredHost) playSuccessBeat("host");
    }
    previousStepRef.current = step;
  }, [discoveredHost, discoveredVerification, playSuccessBeat, step, successBeat]);

  useEffect(() => {
    if (
      step !== "done" ||
      transitionBeat !== null ||
      completion.status !== "working" ||
      completionStartedRef.current
    ) {
      return;
    }

    // Onboarding's job ends with a machine you own. It used to also create a
    // workspace and open a shell in the home directory — so the first thing
    // anyone saw of the product was a terminal somebody else had chosen for
    // them, in a folder they had not picked. `/app` refuses to do that in so
    // many words ("the first workspace is a deliberate act"), and this doing
    // it anyway meant the two doors into the product disagreed.
    //
    // So hand over. `/app` decides where "my work" is — the create-your-first
    // -workspace state for a new account, the last workspace for a returning
    // one — and it is the same answer however you arrived.
    completionStartedRef.current = true;
    setCompletion({ status: "success", message: "Your machine is connected." });
    // Deliberately not cleaned up on re-run: setting the state above changes
    // `completion.status`, which re-runs this effect — and a cleanup here would
    // clear the very timer that does the handover, leaving the reader parked on
    // a success message for ever. `completionStartedRef` makes it one-shot and
    // `mountedRef` makes it harmless after unmount.
    window.setTimeout(() => {
      if (mountedRef.current) router.replace("/app");
    }, SUCCESS_BEAT_MS);
  }, [completion.status, router, step, transitionBeat]);

  if (authState.error) {
    return (
      <LoadFailure
        title="Couldn’t load your account"
        message="Check your connection, then try again."
        onRetry={() => void authState.refetch()}
      />
    );
  }

  if (configState.error) {
    return (
      <LoadFailure
        title="Couldn’t load sign-in options"
        message="Check your connection, then try again."
        onRetry={() => void configState.refetch()}
      />
    );
  }

  if (verificationSatisfied && hostsQuery.isError) {
    return (
      <LoadFailure
        title="Couldn’t check your hosts"
        message="Your setup is safe. Try the connection again."
        onRetry={() => void hostsQuery.refetch()}
      />
    );
  }

  if (step === null || config === null) {
    return <LoadingShell />;
  }

  const visibleStep: OnboardingStep = transitionBeat ?? step;
  // A gate the server would never enforce has no business on the rail: with no
  // mailer configured, /api/auth/config reports verification as not required,
  // and showing "Verify" only makes the jump to Host read as a skipped step.
  const visibleSteps = config.email_verification_required
    ? ONBOARDING_STEPS
    : ONBOARDING_STEPS.filter((candidate) => candidate !== "verify");
  // No "setup complete, connect a host whenever you like" variant any more:
  // reaching `done` now means a host is online, because that is the only way
  // through the gate.
  const copy = STEP_COPY[visibleStep];

  return (
    <AuthShell
      title={copy.title}
      description={copy.description}
      step={visibleStep}
      steps={visibleSteps}
      layout="split"
    >
      {transitionBeat === "verify" ? (
        <SuccessBeat message="Email verified. Moving on…" />
      ) : transitionBeat === "host" ? (
        <SuccessBeat message="Your host is online. Building a workspace…" />
      ) : step === "account" ? (
        <AccountStep
          config={config}
          invite={searchParams.get("invite")}
          onSuccess={(nextUser) => queryClient.setQueryData(["me"], { user: nextUser })}
        />
      ) : step === "verify" && user !== null ? (
        <VerifyStep email={user.email} />
      ) : step === "host" ? (
        <div className="space-y-5">
          <div className="min-w-0 [&_button]:min-h-11 [&_button]:min-w-11 [&_input]:min-h-11">
            {approvalChecked ? (
              <ConnectHostSection
                onHostOnline={onHostOnline}
                frameless
                autoLoadFromUrl={approvalFromLink}
                onPairingApproved={() => {
                  // The ceremony is spent. Leaving `?ref=` on the URL means any
                  // later remount auto-loads a consumed approval, which fails
                  // and leaves an empty code box sitting where the answer was.
                  const url = new URL(window.location.href);
                  url.searchParams.delete("ref");
                  url.searchParams.delete("code");
                  window.history.replaceState(
                    window.history.state,
                    "",
                    `${url.pathname}${url.search}`,
                  );
                  // `approvalFromLink` deliberately stays true: it records how
                  // this visit arrived, and the layout keyed off it must not
                  // change under the reader mid-flow.
                }}
                // A link-borne ceremony is already waiting to be approved; minting
                // a second setup claim beside it would offer two ways to pair the
                // same machine.
                mintSetupClaim={!approvalFromLink && approvedOfflineHost === null}
                resumeApprovedHost={approvedOfflineHost}
              />
            ) : (
              <div className="flex min-h-48 items-center justify-center px-6">
                <PaceBar className="w-full max-w-xs" label="Opening this step…" />
              </div>
            )}
          </div>
        </div>
      ) : (
        <CompletionBeat
          state={completion}
          onRetry={() => {
            completionStartedRef.current = false;
            setCompletion({ status: "working" });
          }}
        />
      )}
    </AuthShell>
  );
}

function AccountStep({
  config,
  invite,
  onSuccess,
}: {
  config: NonNullable<ReturnType<typeof useAuthConfig>["config"]>;
  invite: string | null;
  onSuccess: (user: User) => void;
}) {
  return (
    <div className="space-y-4">
      {invite !== null ? (
        <p
          className="rounded-sm border border-ember/40 bg-ember/10 px-3 py-2 text-sm text-bone"
          role="status"
        >
          Your invite is ready. Create the account it belongs to.
        </p>
      ) : null}
      <SignupForm
        config={config}
        initialInvite={invite}
        oauthReturnTo="/onboarding"
        onSuccess={onSuccess}
        submitLabel="Create account and continue"
      />
      <p className="text-center text-sm text-ash">
        Already have an account?{" "}
        <Link
          href="/login"
          className="inline-flex min-h-11 items-center font-medium text-ember underline decoration-ember/50 underline-offset-4 transition-colors hover:text-hellfire hover:decoration-ember"
        >
          Log in instead
        </Link>
      </p>
    </div>
  );
}

function VerifyStep({ email }: { email: string }) {
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const resend = async () => {
    setSending(true);
    setNotice(null);
    try {
      await auth.requestEmailVerification();
      setNotice({ tone: "success", message: "A fresh verification link is on its way." });
    } catch (cause) {
      setNotice({
        tone: "error",
        message:
          cause instanceof ApiError && cause.status === 429
            ? "You’ve requested several links already. Please wait a while before trying again."
            : cause instanceof ApiError
              ? cause.message
              : "Could not send another link. Please try again.",
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-sm border border-line-g bg-panelg p-4">
        <Mail className="mt-0.5 size-5 shrink-0 text-ember" aria-hidden />
        <p className="min-w-0 text-sm leading-6">
          We sent a link to <span className="break-all font-medium">{email}</span>.
        </p>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">
        Open it in any tab. This page checks every five seconds and will continue automatically.
      </p>
      {notice ? (
        <p
          className={
            notice.tone === "success" ? "text-sm text-success" : "text-sm text-destructive"
          }
          role={notice.tone === "success" ? "status" : "alert"}
        >
          {notice.message}
        </p>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        className="h-11 w-full"
        disabled={sending}
        onClick={() => void resend()}
      >
        {sending ? <Spinner label="Sending verification email" /> : <RotateCw className="size-4" />}
        {sending ? "Sending…" : "Resend email"}
      </Button>
    </div>
  );
}

function SuccessBeat({ message }: { message: string }) {
  return (
    <div
      className="flex min-h-32 flex-col items-center justify-center gap-3 text-center"
      role="status"
    >
      <span className="flex size-9 items-center justify-center rounded-full border border-ember/40 bg-ember/12 text-ember">
        <Check className="size-5" aria-hidden />
      </span>
      <p className="text-sm font-medium">{message}</p>
    </div>
  );
}

function CompletionBeat({ state, onRetry }: { state: CompletionState; onRetry: () => void }) {
  if (state.status === "failed") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive" role="alert">
          {state.message}
        </p>
        <Button type="button" className="h-11 w-full" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  if (state.status === "success") return <SuccessBeat message={state.message} />;

  return (
    <div className="flex min-h-32 items-center justify-center px-6">
      <PaceBar className="w-full max-w-xs" label="Preparing your workspace…" />
    </div>
  );
}

function LoadingShell() {
  return (
    <AuthShell title="Preparing setup" layout="split">
      <div className="flex min-h-28 items-center justify-center">
        <Spinner size={20} label="Preparing onboarding" />
      </div>
    </AuthShell>
  );
}

function LoadFailure({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <AuthShell title={title} description={message} layout="split">
      <Button type="button" className="h-11 w-full" onClick={onRetry}>
        Try again
      </Button>
    </AuthShell>
  );
}
