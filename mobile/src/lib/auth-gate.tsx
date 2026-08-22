import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { readHostSkipped } from "@/components/onboarding/onboarding-state";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { authToken } from "@/data/api/auth-token";
import { ApiError, subscribeUnauthenticated } from "@/data/api/client";
import { useAuthConfigQuery, useAuthHostsQuery, useMeQuery } from "@/data/queries/auth";
import { spacing, useTheme } from "@/theme";

export const AUTH_GATE_DESTINATIONS = {
  login: "/login",
  verifyEmail: "/verify-email",
  onboarding: "/onboarding",
  tabs: "/workspaces",
} as const;

export type AuthGateDestination =
  (typeof AUTH_GATE_DESTINATIONS)[keyof typeof AUTH_GATE_DESTINATIONS];

export interface AuthGateDecisionInput {
  hasToken: boolean;
  emailVerified: boolean;
  verificationRequired: boolean;
  hostCount: number;
  hostSkipped: boolean;
}

export function resolveAuthGateDestination({
  hasToken,
  emailVerified,
  verificationRequired,
  hostCount,
  hostSkipped,
}: AuthGateDecisionInput): AuthGateDestination {
  if (!hasToken) return AUTH_GATE_DESTINATIONS.login;
  if (verificationRequired && !emailVerified) return AUTH_GATE_DESTINATIONS.verifyEmail;
  if (hostCount === 0 && !hostSkipped) return AUTH_GATE_DESTINATIONS.onboarding;
  return AUTH_GATE_DESTINATIONS.tabs;
}

export interface OnceRedirect {
  redirect(): void;
  reset(): void;
}

export function createUnauthenticatedRedirect(
  replace: (destination: typeof AUTH_GATE_DESTINATIONS.login) => void,
): OnceRedirect {
  let redirected = false;
  return {
    redirect() {
      if (redirected) return;
      redirected = true;
      replace(AUTH_GATE_DESTINATIONS.login);
    },
    reset() {
      redirected = false;
    },
  };
}

type TokenState =
  | { status: "loading"; requestId: string }
  | { status: "ready"; token: string | null; requestId: string }
  | { status: "error"; error: unknown; requestId: string };

type HostSkipState =
  | { status: "loading"; requestId: string }
  | { status: "ready"; skipped: boolean; requestId: string };

type BootstrapState =
  | { status: "loading"; hasToken: boolean }
  | { status: "error"; kind: "account" | "config"; error: unknown; retry(): void }
  | { status: "ready"; destination: AuthGateDestination; hasToken: boolean };

export function useAuthBootstrap(refreshKey = "launch"): BootstrapState {
  const [tokenAttempt, setTokenAttempt] = useState(0);
  const requestId = `${refreshKey}:${tokenAttempt}`;
  const [tokenState, setTokenState] = useState<TokenState>({
    status: "loading",
    requestId,
  });
  const [hostSkipState, setHostSkipState] = useState<HostSkipState>({
    status: "loading",
    requestId,
  });

  useEffect(() => {
    let active = true;
    setTokenState({ status: "loading", requestId });
    authToken.get().then(
      (token) => {
        if (active) setTokenState({ status: "ready", token, requestId });
      },
      (error: unknown) => {
        if (active) setTokenState({ status: "error", error, requestId });
      },
    );
    return () => {
      active = false;
    };
  }, [requestId]);

  const hasToken = tokenState.status === "ready" && tokenState.token !== null;

  useEffect(() => {
    if (!hasToken) return;
    let active = true;
    setHostSkipState({ status: "loading", requestId });
    readHostSkipped().then(
      (skipped) => {
        if (active) setHostSkipState({ status: "ready", skipped, requestId });
      },
      () => {
        // If account-local preferences cannot be read, keep the safer first-run gate.
        if (active) setHostSkipState({ status: "ready", skipped: false, requestId });
      },
    );
    return () => {
      active = false;
    };
  }, [hasToken, requestId]);

  const configQuery = useAuthConfigQuery(hasToken);
  const meQuery = useMeQuery(hasToken);
  const hostsQuery = useAuthHostsQuery(hasToken && meQuery.data !== undefined);

  const retry = useCallback(() => {
    setTokenAttempt((attempt) => attempt + 1);
    if (hasToken) {
      void configQuery.refetch();
      void meQuery.refetch();
      if (meQuery.data !== undefined) void hostsQuery.refetch();
    }
  }, [configQuery, hasToken, hostsQuery, meQuery]);

  if (tokenState.status === "loading") return { status: "loading", hasToken: false };
  if (tokenState.status === "error") {
    return { status: "error", kind: "account", error: tokenState.error, retry };
  }
  if (!hasToken) {
    return {
      status: "ready",
      hasToken: false,
      destination: AUTH_GATE_DESTINATIONS.login,
    };
  }

  const authenticatedError = meQuery.error ?? hostsQuery.error;
  if (authenticatedError instanceof ApiError && authenticatedError.status === 401) {
    return {
      status: "ready",
      hasToken: false,
      destination: AUTH_GATE_DESTINATIONS.login,
    };
  }
  if (configQuery.error !== null) {
    return { status: "error", kind: "config", error: configQuery.error, retry };
  }
  if (authenticatedError !== null) {
    return { status: "error", kind: "account", error: authenticatedError, retry };
  }
  if (
    configQuery.data === undefined ||
    meQuery.data === undefined ||
    hostsQuery.data === undefined ||
    hostSkipState.status !== "ready" ||
    hostSkipState.requestId !== requestId
  ) {
    return { status: "loading", hasToken: true };
  }

  return {
    status: "ready",
    hasToken: true,
    destination: resolveAuthGateDestination({
      hasToken: true,
      emailVerified: meQuery.data.user.email_verified_at !== null,
      verificationRequired: configQuery.data.email_verification_required,
      hostCount: hostsQuery.data.length,
      hostSkipped: hostSkipState.skipped,
    }),
  };
}

const ALWAYS_PUBLIC_PATHS = new Set(["/reset-password", "/verify-email"]);
const SIGNED_OUT_PUBLIC_PATHS = new Set(["/login", "/signup", "/forgot-password", "/server"]);
const STANDALONE_PAIRING_PATHS = new Set([
  "/device",
  "/host",
  `${AUTH_GATE_DESTINATIONS.onboarding}/device`,
  `${AUTH_GATE_DESTINATIONS.onboarding}/host`,
]);

export function shouldRenderAuthPath(
  pathname: string,
  destination: AuthGateDestination,
  hasToken: boolean,
): boolean {
  if (ALWAYS_PUBLIC_PATHS.has(pathname)) return true;
  if (!hasToken && SIGNED_OUT_PUBLIC_PATHS.has(pathname)) return true;
  if (
    hasToken &&
    destination !== AUTH_GATE_DESTINATIONS.verifyEmail &&
    STANDALONE_PAIRING_PATHS.has(pathname)
  ) {
    return true;
  }
  if (destination === AUTH_GATE_DESTINATIONS.login) return pathname === destination;
  if (destination === AUTH_GATE_DESTINATIONS.verifyEmail) return pathname === destination;
  if (destination === AUTH_GATE_DESTINATIONS.onboarding) {
    return pathname === destination || pathname.startsWith(`${destination}/`);
  }
  return (
    pathname !== "/" &&
    !SIGNED_OUT_PUBLIC_PATHS.has(pathname) &&
    !pathname.startsWith(AUTH_GATE_DESTINATIONS.onboarding)
  );
}

function GateLoading() {
  return (
    <View accessibilityLabel="Loading account" style={styles.centered}>
      <Spinner label="Loading account" />
    </View>
  );
}

function GateError({ kind, retry }: { kind: "account" | "config"; retry(): void }) {
  return (
    <View style={styles.centered}>
      <View style={styles.errorCopy}>
        <Text style={styles.centeredText} variant="title">
          {kind === "config" ? "Couldn’t load sign-in options" : "Couldn’t load your account"}
        </Text>
        <Text color="mutedForeground" style={styles.centeredText}>
          Check your connection, then try again.
        </Text>
      </View>
      <Button accessibilityLabel="Try again" onPress={retry}>
        Try again
      </Button>
    </View>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const theme = useTheme();
  const bootstrap = useAuthBootstrap(pathname);
  const redirectRef = useRef<OnceRedirect | null>(null);
  if (redirectRef.current === null) {
    redirectRef.current = createUnauthenticatedRedirect((destination) => {
      queryClient.removeQueries();
      router.replace(destination);
    });
  }

  useEffect(() => subscribeUnauthenticated(() => redirectRef.current?.redirect()), []);
  useEffect(() => {
    if (bootstrap.status === "ready" && bootstrap.hasToken) {
      redirectRef.current?.reset();
    }
  }, [bootstrap]);

  const shouldRender =
    bootstrap.status === "ready" &&
    shouldRenderAuthPath(pathname, bootstrap.destination, bootstrap.hasToken);

  useEffect(() => {
    if (bootstrap.status === "ready" && !shouldRender) {
      router.replace(bootstrap.destination);
    }
  }, [bootstrap, router, shouldRender]);

  if (bootstrap.status === "error") {
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <GateError kind={bootstrap.kind} retry={bootstrap.retry} />
      </View>
    );
  }
  if (!shouldRender) {
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <GateLoading />
      </View>
    );
  }
  return children;
}

const styles = StyleSheet.create({
  centered: {
    alignItems: "center",
    flex: 1,
    gap: spacing[5],
    justifyContent: "center",
    padding: spacing[6],
  },
  centeredText: {
    textAlign: "center",
  },
  errorCopy: {
    gap: spacing[2],
  },
  root: {
    flex: 1,
  },
});
