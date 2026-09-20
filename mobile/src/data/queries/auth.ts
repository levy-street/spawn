import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getMe } from "@/data/api/endpoints/account";
import {
  confirmEmailVerification,
  confirmPasswordReset,
  getAuthConfig,
  joinWaitlist,
  logIn,
  requestEmailVerification,
  requestPasswordReset,
  signOutEverywhere,
  signUp,
} from "@/data/api/endpoints/auth";
import { listHosts } from "@/data/api/endpoints/hosts";
import type { MeResponse, ProviderId, TokenResponse, UserOut } from "@/data/api/schemas/auth";
import { qk } from "@/data/queryKeys";
import { isAppleSignInAvailable, signInWithAppleNatively } from "@/lib/apple-auth";
import { signInWithProvider } from "@/lib/oauth";

function seedMe(queryClient: ReturnType<typeof useQueryClient>, user: UserOut): void {
  queryClient.setQueryData<MeResponse>(qk.me(), { user });
}

/** Clear the previous account without orphaning mounted auth-gate observers. */
export function adoptAuthenticatedAccount(queryClient: QueryClient, user: UserOut): Promise<void> {
  queryClient.removeQueries({ predicate: (query) => query.getObserversCount() === 0 });
  // Reset retains disabled-but-mounted queries too. Removing their Query objects
  // leaves the gate observing old pending/error results after a successful login.
  const reset = queryClient.resetQueries();
  // Keep this synchronous with the login result; a later login must not be
  // overwritten after waiting for unrelated refetches to complete.
  seedMe(queryClient, user);
  return reset;
}

export function useAuthConfigQuery(enabled = true) {
  return useQuery({
    queryKey: qk.authConfig(),
    queryFn: getAuthConfig,
    enabled,
  });
}

export function useMeQuery(enabled = true, refetchInterval?: number) {
  return useQuery({
    queryKey: qk.me(),
    queryFn: getMe,
    enabled,
    ...(refetchInterval === undefined ? {} : { refetchInterval }),
  });
}

export function useAuthHostsQuery(enabled = true) {
  return useQuery({
    queryKey: qk.hosts(),
    queryFn: listHosts,
    enabled,
  });
}

export function useLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logIn,
    onSuccess: (result) => {
      adoptAuthenticatedAccount(queryClient, result.user);
    },
  });
}

export function useSignupMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: signUp,
    onSuccess: (result) => {
      adoptAuthenticatedAccount(queryClient, result.user);
    },
  });
}

/**
 * A provider sign-in, as a mutation the auth screens can drive.
 *
 * Resolves to `null` when the user backs out of the web view or the Apple
 * sheet. That is not an error and must not be shown as one — the screen simply
 * returns to where it was, with nothing said.
 */
export function useOAuthSignInMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      provider,
      invite,
    }: {
      provider: ProviderId;
      invite?: string | null;
    }): Promise<TokenResponse | null> => {
      const outcome =
        provider === "apple" && (await isAppleSignInAvailable())
          ? await signInWithAppleNatively({ invite: invite ?? null })
          : await signInWithProvider(provider, { invite: invite ?? null });
      if (outcome.status === "cancelled") return null;
      if (outcome.status === "failed") throw new Error(outcome.message);
      return outcome.token;
    },
    onSuccess: (result) => {
      if (result === null) return;
      adoptAuthenticatedAccount(queryClient, result.user);
    },
  });
}

export function useJoinWaitlistMutation() {
  return useMutation({ mutationFn: joinWaitlist });
}

export function usePasswordResetRequestMutation() {
  return useMutation({ mutationFn: requestPasswordReset });
}

export function useSignOutEverywhereMutation() {
  return useMutation({ mutationFn: signOutEverywhere });
}

export function usePasswordResetConfirmMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: confirmPasswordReset,
    onSuccess: (result) => {
      seedMe(queryClient, result.user);
    },
  });
}

const verificationRequests = new Map<string, ReturnType<typeof confirmEmailVerification>>();

export function confirmEmailOnce(token: string) {
  const existing = verificationRequests.get(token);
  if (existing !== undefined) return existing;
  const request = confirmEmailVerification({ token });
  verificationRequests.set(token, request);
  return request;
}

export function useEmailVerificationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: confirmEmailOnce,
    onSuccess: (result) => {
      seedMe(queryClient, result.user);
    },
  });
}

export function useEmailVerificationRequestMutation() {
  return useMutation({ mutationFn: requestEmailVerification });
}
