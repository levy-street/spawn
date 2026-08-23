import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getMe } from "@/data/api/endpoints/account";
import {
  confirmEmailVerification,
  confirmPasswordReset,
  getAuthConfig,
  logIn,
  requestEmailVerification,
  requestPasswordReset,
  signUp,
} from "@/data/api/endpoints/auth";
import { listHosts } from "@/data/api/endpoints/hosts";
import type { MeResponse, UserOut } from "@/data/api/schemas/auth";
import { qk } from "@/data/queryKeys";

function seedMe(queryClient: ReturnType<typeof useQueryClient>, user: UserOut): void {
  queryClient.setQueryData<MeResponse>(qk.me(), { user });
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
      queryClient.removeQueries();
      seedMe(queryClient, result.user);
    },
  });
}

export function useSignupMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: signUp,
    onSuccess: (result) => {
      queryClient.removeQueries();
      seedMe(queryClient, result.user);
    },
  });
}

export function usePasswordResetRequestMutation() {
  return useMutation({ mutationFn: requestPasswordReset });
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
