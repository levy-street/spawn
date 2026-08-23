import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { AuthAction } from "@/components/auth/auth-actions";
import { AuthMessage } from "@/components/auth/auth-message";
import { AuthBlock, AuthShell } from "@/components/auth/auth-shell";
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
import { duration, fontFamily, fontSize, spacing } from "@/theme";

type SessionState = "checking" | "signed-in" | "signed-out";
type LinkState =
  | { status: "working" }
  | { status: "done"; signedIn: boolean }
  | { status: "failed"; message: string };

function VerifySuccess({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  return (
    <>
      <AuthMessage tone="success">Your true name is confirmed.</AuthMessage>
      <AuthBlock>
        <AuthAction
          label={signedIn ? "Continue to spawn" : "Sign in to continue"}
          onPress={() => router.replace(signedIn ? "/" : "/login")}
        />
      </AuthBlock>
    </>
  );
}

function Working({ label, message }: { label: string; message?: string }) {
  return (
    <View accessibilityLabel={message ?? label} style={styles.working}>
      <Spinner label={label} />
      {message === undefined ? null : <Text color="mutedForeground">{message}</Text>}
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
    return <Working label="Verifying email" message="Verifying your email…" />;
  }
  if (state.status === "done") return <VerifySuccess signedIn={state.signedIn} />;

  return <VerificationFailure message={state.message} />;
}

function VerificationFailure({ message }: { message: string }) {
  const router = useRouter();
  return (
    <>
      <AuthMessage tone="error">{message}</AuthMessage>
      <AuthBlock>
        <Text color="mutedForeground" style={styles.copy}>
          A verification link burns out after two days, and works only once. Sign in and call for a
          fresh one from Settings.
        </Text>
      </AuthBlock>
      <AuthBlock>
        <AuthAction label="Go to sign in" onPress={() => router.replace("/login")} tone="quiet" />
      </AuthBlock>
    </>
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

  if (meQuery.isPending) return <Working label="Checking verification" />;
  if (meQuery.isError || meQuery.data === undefined) {
    return (
      <>
        <AuthMessage tone="error">Couldn’t load your account</AuthMessage>
        <AuthBlock>
          <AuthAction label="Go to sign in" onPress={() => router.replace("/login")} />
        </AuthBlock>
      </>
    );
  }

  return (
    <>
      <AuthBlock>
        <Text style={styles.copy}>
          We sent a link to{" "}
          <Text style={styles.address} testID="verify-address">
            {meQuery.data.user.email}
          </Text>
          .
        </Text>
        <Text color="mutedForeground" style={[styles.copy, styles.secondLine]}>
          Open it anywhere. This screen is watching, and moves on the moment it is done.
        </Text>
      </AuthBlock>
      {message !== null ? <AuthMessage tone="success">{message}</AuthMessage> : null}
      {error !== null ? <AuthMessage tone="error">{error}</AuthMessage> : null}
      <AuthBlock>
        <AuthAction
          label={resend.isPending ? "Sending…" : "Resend email"}
          loading={resend.isPending}
          onPress={() => {
            void sendAgain();
          }}
          tone="quiet"
        />
      </AuthBlock>
    </>
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
    content = <Working label="Loading verification" />;
  } else if (sessionState === "signed-in") {
    content = <VerificationWaiting />;
  } else {
    content = <MissingVerificationToken />;
  }

  return (
    <AuthShell
      description="Confirm the address bound to your account. Nothing answers to a name it cannot verify."
      title="Your true name"
    >
      {content}
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  address: {
    fontFamily: fontFamily.mono,
  },
  copy: {
    fontFamily: fontFamily.grimoireRegular,
    fontSize: fontSize.fifteen,
    lineHeight: spacing[6],
  },
  secondLine: {
    marginTop: spacing[3],
  },
  working: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    justifyContent: "center",
    minHeight: spacing[24],
  },
});
