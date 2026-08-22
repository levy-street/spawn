import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { AuthMessage } from "@/components/auth/auth-message";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { authToken } from "@/data/api/auth-token";
import { ApiError } from "@/data/api/client";
import {
  useEmailVerificationMutation,
  useEmailVerificationRequestMutation,
  useMeQuery,
} from "@/data/queries/auth";
import { haptics } from "@/lib/haptics";
import { duration, spacing } from "@/theme";

type SessionState = "checking" | "signed-in" | "signed-out";
type LinkState =
  | { status: "working" }
  | { status: "done"; signedIn: boolean }
  | { status: "failed"; message: string };

function VerifySuccess({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  return (
    <View style={styles.content}>
      <AuthMessage tone="success">Your email address is verified.</AuthMessage>
      <Button
        accessibilityLabel={signedIn ? "Continue to spawn" : "Sign in to continue"}
        onPress={() => router.replace(signedIn ? "/" : "/login")}
        size="lg"
      >
        {signedIn ? "Continue to spawn" : "Sign in to continue"}
      </Button>
    </View>
  );
}

function VerificationLink({ token }: { token: string }) {
  const { mutateAsync: verifyEmail } = useEmailVerificationMutation();
  const [state, setState] = useState<LinkState>({ status: "working" });

  useEffect(() => {
    let active = true;
    void verifyEmail(token).then(
      async () => {
        const signedIn = (await authToken.get()) !== null;
        if (!active) return;
        haptics.success();
        setState({ status: "done", signedIn });
      },
      (error: unknown) => {
        if (!active) return;
        haptics.error();
        setState({
          status: "failed",
          message: error instanceof ApiError ? error.message : "Could not verify this address",
        });
      },
    );
    return () => {
      active = false;
    };
  }, [token, verifyEmail]);

  if (state.status === "working") {
    return (
      <View accessibilityLabel="Verifying your email…" style={styles.working}>
        <Spinner label="Verifying email" />
        <Text color="mutedForeground">Verifying your email…</Text>
      </View>
    );
  }
  if (state.status === "done") return <VerifySuccess signedIn={state.signedIn} />;

  return <VerificationFailure message={state.message} />;
}

function VerificationFailure({ message }: { message: string }) {
  const router = useRouter();
  return (
    <View style={styles.content}>
      <AuthMessage tone="error">{message}</AuthMessage>
      <Text color="mutedForeground" style={styles.longCopy}>
        Verification links work once and expire after two days. Sign in and request a fresh one from
        Settings.
      </Text>
      <Button
        accessibilityLabel="Go to sign in"
        onPress={() => router.replace("/login")}
        size="lg"
        variant="secondary"
      >
        Go to sign in
      </Button>
    </View>
  );
}

function VerificationWaiting() {
  const router = useRouter();
  const meQuery = useMeQuery(true, duration.toastInfo);
  const resend = useEmailVerificationRequestMutation();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (meQuery.data !== undefined && meQuery.data.user.email_verified_at !== null) {
    return <VerifySuccess signedIn />;
  }

  const sendAgain = async () => {
    setMessage(null);
    setError(null);
    try {
      await resend.mutateAsync();
      setMessage("A fresh verification link is on its way.");
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 429
          ? "You’ve requested several links already. Please wait a while before trying again."
          : cause instanceof ApiError
            ? cause.message
            : "Could not send a fresh verification link",
      );
    }
  };

  if (meQuery.isPending) {
    return (
      <View style={styles.working}>
        <Spinner label="Checking verification" />
      </View>
    );
  }
  if (meQuery.isError || meQuery.data === undefined) {
    return (
      <View style={styles.content}>
        <AuthMessage tone="error">Couldn’t load your account</AuthMessage>
        <Button
          accessibilityLabel="Go to sign in"
          onPress={() => router.replace("/login")}
          size="lg"
        >
          Go to sign in
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.content}>
      <Text>
        We sent a link to <Text weight="medium">{meQuery.data.user.email}</Text>.
      </Text>
      <Text color="mutedForeground" style={styles.longCopy}>
        Open it in any tab. This page checks every five seconds and will continue automatically.
      </Text>
      {message !== null ? <AuthMessage tone="success">{message}</AuthMessage> : null}
      {error !== null ? <AuthMessage tone="error">{error}</AuthMessage> : null}
      <Button
        accessibilityLabel={resend.isPending ? "Sending…" : "Resend email"}
        loading={resend.isPending}
        onPress={() => {
          void sendAgain();
        }}
        size="lg"
        variant="secondary"
      >
        {resend.isPending ? "Sending…" : "Resend email"}
      </Button>
    </View>
  );
}

function MissingVerificationToken() {
  return <VerificationFailure message="This link is missing its token." />;
}

export function VerifyEmailScreen({ token }: { token?: string }) {
  const [sessionState, setSessionState] = useState<SessionState>("checking");

  useEffect(() => {
    let active = true;
    if (token !== undefined) return undefined;
    void authToken.get().then(
      (storedToken) => {
        if (active) setSessionState(storedToken === null ? "signed-out" : "signed-in");
      },
      () => {
        if (active) setSessionState("signed-out");
      },
    );
    return () => {
      active = false;
    };
  }, [token]);

  let content: ReactNode;
  if (token !== undefined) {
    content = <VerificationLink token={token} />;
  } else if (sessionState === "checking") {
    content = (
      <View style={styles.working}>
        <Spinner label="Loading verification" />
      </View>
    );
  } else if (sessionState === "signed-in") {
    content = <VerificationWaiting />;
  } else {
    content = <MissingVerificationToken />;
  }

  return (
    <AuthShell
      description="Confirm the address attached to your spawnd account."
      title="Verify your email"
    >
      {content}
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing[5],
  },
  longCopy: {
    lineHeight: spacing[6],
  },
  working: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    justifyContent: "center",
    minHeight: spacing[24] + spacing[8],
  },
});
