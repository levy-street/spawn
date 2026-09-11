import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createAdminInvite,
  getAdminMailStatus,
  inviteFromAdminWaitlist,
  listAdminEmails,
  listAdminInvites,
  listAdminUsers,
  listAdminWaitlist,
  removeFromAdminWaitlist,
  revokeAdminInvite,
  sendAdminTestEmail,
} from "@/data/api/endpoints/admin";
import type {
  AdminEmailOut,
  AdminInviteCreate,
  AdminInviteOut,
  AdminTestEmail,
  AdminWaitlistEntryOut,
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

export function useAdminWaitlistQuery(enabled = true) {
  return useQuery({
    queryKey: qk.adminWaitlist(),
    queryFn: listAdminWaitlist,
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

export interface InviteFromWaitlistInput {
  entryId: string;
  ttlHours?: number | null;
}

export function useInviteFromWaitlistMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ entryId, ttlHours }: InviteFromWaitlistInput) =>
      inviteFromAdminWaitlist(entryId, { ttl_hours: ttlHours ?? null }),
    onSuccess: (invite, { entryId }) => {
      // The invite is an ordinary one and belongs in that list too.
      queryClient.setQueryData<AdminInviteOut[]>(qk.adminInvites(), (rows) => [
        invite,
        ...(rows ?? []).filter((row) => row.id !== invite.id),
      ]);
      // The entry now points at this invite; the server confirms the rest.
      queryClient.setQueryData<AdminWaitlistEntryOut[]>(qk.adminWaitlist(), (rows) =>
        (rows ?? []).map((row) =>
          row.id === entryId
            ? {
                ...row,
                invite_id: invite.id,
                invite_state: invite.state,
                invited_at: invite.created_at,
              }
            : row,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: qk.adminWaitlist() });
    },
  });
}

export function useRemoveFromWaitlistMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entryId: string) => removeFromAdminWaitlist(entryId),
    onSuccess: (_result, entryId) => {
      queryClient.setQueryData<AdminWaitlistEntryOut[]>(qk.adminWaitlist(), (rows) =>
        (rows ?? []).filter((row) => row.id !== entryId),
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
