"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Mail, RotateCw } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectHostSection } from "@/components/hosts/connect-host";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, auth, type Host, hosts, type User, workspaces } from "@/lib/api";
import { useAuth, useAuthConfig } from "@/lib/auth";
import { AuthShell } from "./auth-shell";
import { SignupForm } from "./signup-form";
import { ONBOARDING_STEPS, type OnboardingStep, resolveStep } from "./step-machine";

const SKIPPED_HOST_KEY = "spawn.onboarding.skippedHost";
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
    title: "Your workspace is ready",
    description: "We’re opening a shell on your connected machine.",
  },
};

export function OnboardingFlow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const authState = useAuth();
  const configState = useAuthConfig();
  const [storage, setStorage] = useState({ ready: false, skippedHost: false });
  const [successBeat, setSuccessBeat] = useState<SuccessBeat>(null);
  const [completion, setCompletion] = useState<CompletionState>({ status: "working" });
  const successTimerRef = useRef<number | null>(null);
  const completionStartedRef = useRef(false);
  const mountedRef = useRef(true);
  const previousStepRef = useRef<OnboardingStep | null>(null);

  useEffect(() => {
    setStorage({
      ready: true,
      skippedHost: window.localStorage.getItem(SKIPPED_HOST_KEY) !== null,
    });
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
          skippedHost: storage.skippedHost,
        },
        searchParams.get("step"),
      )
    : null;

  const workspacesQuery = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaces.list(),
    enabled: step === "done",
    retry: 1,
  });

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

  const skipHost = () => {
    window.localStorage.setItem(SKIPPED_HOST_KEY, "true");
    setStorage({ ready: true, skippedHost: true });
  };

  const workspaceDataReady = workspacesQuery.data !== undefined;
  const workspaceCount = workspacesQuery.data?.length ?? 0;
  const onlineHost = hostsQuery.data?.find((host) => host.status === "online") ?? null;
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
      !workspaceDataReady ||
      workspacesQuery.isError ||
      completion.status !== "working" ||
      completionStartedRef.current
    ) {
      return;
    }

    completionStartedRef.current = true;
    setCompletion({ status: "working" });

    void (async () => {
      try {
        if (workspaceCount === 0 && onlineHost !== null) {
          const result = await workspaces.create({
            first_session: { host_id: onlineHost.id, cwd: "~" },
          });
          if (!mountedRef.current) return;
          setCompletion({ status: "success", message: "Host connected. Shell summoned." });
          await new Promise((resolve) => window.setTimeout(resolve, SUCCESS_BEAT_MS));
          if (mountedRef.current) router.replace(`/w/${result.workspace.id}`);
          return;
        }

        setCompletion({ status: "success", message: "Setup complete." });
        await new Promise((resolve) => window.setTimeout(resolve, SUCCESS_BEAT_MS));
        if (mountedRef.current) router.replace("/app");
      } catch (cause) {
        if (!mountedRef.current) return;
        completionStartedRef.current = false;
        setCompletion({
          status: "failed",
          message:
            cause instanceof ApiError ? cause.message : "Could not create your first workspace",
        });
      }
    })();
  }, [
    completion.status,
    onlineHost,
    router,
    step,
    transitionBeat,
    workspaceCount,
    workspaceDataReady,
    workspacesQuery.isError,
  ]);

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
  const copy =
    visibleStep === "done" && onlineHost === null
      ? {
          title: "Setup complete",
          description: "Connect a host whenever you’re ready to open your first shell.",
        }
      : STEP_COPY[visibleStep];

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
            <ConnectHostSection onHostOnline={onHostOnline} frameless />
          </div>
          <Button
            type="button"
            variant="link"
            className="h-11 w-full text-ash hover:text-bone"
            onClick={skipHost}
          >
            Skip for now
          </Button>
        </div>
      ) : workspacesQuery.isError ? (
        <div className="space-y-4">
          <p className="text-sm text-destructive" role="alert">
            Could not check your workspaces.
          </p>
          <Button className="h-11 w-full" onClick={() => void workspacesQuery.refetch()}>
            Try again
          </Button>
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
    <div className="flex min-h-32 items-center justify-center gap-3 text-sm text-muted-foreground">
      <Spinner label="Preparing your workspace" />
      Preparing your workspace…
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
