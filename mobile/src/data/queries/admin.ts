import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createAdminInvite,
  getAdminMailStatus,
  listAdminEmails,
  listAdminInvites,
  listAdminUsers,
  revokeAdminInvite,
  sendAdminTestEmail,
} from "@/data/api/endpoints/admin";
import type {
  AdminEmailOut,
  AdminInviteCreate,
  AdminInviteOut,
  AdminTestEmail,
} from "@/data/api/schemas/admin";
import { qk } from "@/data/queryKeys";

export function useAdminUsersQuery(enabled = true) {
  return useQuery({
    queryKey: qk.adminUsers(),
    queryFn: listAdminUsers,
    enabled,
  });
}

export function useAdminInvitesQuery(enabled = true) {
  return useQuery({
    queryKey: qk.adminInvites(),
    queryFn: listAdminInvites,
    enabled,
  });
}

export function useAdminMailQuery(enabled = true) {
  return useQuery({
    queryKey: qk.adminMail(),
    queryFn: getAdminMailStatus,
    enabled,
  });
}

export function useAdminEmailsQuery(enabled = true) {
  return useQuery({
    queryKey: qk.adminEmails(),
    queryFn: () => listAdminEmails(),
    enabled,
  });
}

export function useCreateAdminInviteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AdminInviteCreate) => createAdminInvite(input),
    onSuccess: (invite) => {
      queryClient.setQueryData<AdminInviteOut[]>(qk.adminInvites(), (rows) => [
        invite,
        ...(rows ?? []).filter((row) => row.id !== invite.id),
      ]);
    },
  });
}

export function useRevokeAdminInviteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => revokeAdminInvite(inviteId),
    onSuccess: (invite) => {
      queryClient.setQueryData<AdminInviteOut[]>(qk.adminInvites(), (rows) =>
        (rows ?? []).map((row) => (row.id === invite.id ? invite : row)),
      );
    },
  });
}

export function useSendAdminTestEmailMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AdminTestEmail) => sendAdminTestEmail(input),
    onSuccess: (email) => {
      queryClient.setQueryData<AdminEmailOut[]>(qk.adminEmails(), (rows) => [
        email,
        ...(rows ?? []).filter((row) => row.id !== email.id),
      ]);
    },
  });
}
