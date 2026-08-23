import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import {
  createAdminInvite,
  revokeAdminInvite,
  sendAdminTestEmail,
} from "@/data/api/endpoints/admin";
import type { AdminEmailOut, AdminInviteOut } from "@/data/api/schemas/admin";
import {
  useCreateAdminInviteMutation,
  useRevokeAdminInviteMutation,
  useSendAdminTestEmailMutation,
} from "@/data/queries/admin";
import { qk } from "@/data/queryKeys";

jest.mock("@/data/api/endpoints/admin", () => ({
  createAdminInvite: jest.fn(),
  getAdminMailStatus: jest.fn(),
  listAdminEmails: jest.fn(),
  listAdminInvites: jest.fn(),
  listAdminUsers: jest.fn(),
  revokeAdminInvite: jest.fn(),
  sendAdminTestEmail: jest.fn(),
}));

const INVITE: AdminInviteOut = {
  id: "11111111-1111-4111-8111-111111111111",
  email: null,
  state: "pending",
  expires_at: "2026-08-25T00:00:00Z",
  created_at: "2026-08-22T00:00:00Z",
  used_at: null,
  created_by_user_id: "22222222-2222-4222-8222-222222222222",
  used_by_user_id: null,
  url: "https://spawn.example/signup?invite=secret",
};

const EMAIL: AdminEmailOut = {
  id: "33333333-3333-4333-8333-333333333333",
  to_email: "admin@example.com",
  subject: "spawn test email",
  kind: "test",
  status: "sent",
  error: null,
  body_redacted: "test",
  created_at: "2026-08-22T00:00:00Z",
};

function harness() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe("admin query mutations", () => {
  beforeEach(() => jest.clearAllMocks());

  test("create and revoke keep the invitation cache authoritative", async () => {
    jest.mocked(createAdminInvite).mockResolvedValue(INVITE);
    jest.mocked(revokeAdminInvite).mockResolvedValue({ ...INVITE, state: "revoked", url: null });
    const { queryClient, wrapper } = harness();
    const create = await renderHook(() => useCreateAdminInviteMutation(), { wrapper });
    await act(async () => {
      await create.result.current.mutateAsync({ email: null, ttl_hours: 72 });
    });
    expect(queryClient.getQueryData(qk.adminInvites())).toEqual([INVITE]);
    await create.unmount();

    const revoke = await renderHook(() => useRevokeAdminInviteMutation(), { wrapper });
    await act(async () => {
      await revoke.result.current.mutateAsync(INVITE.id);
    });
    await waitFor(() =>
      expect(queryClient.getQueryData<AdminInviteOut[]>(qk.adminInvites())?.[0]?.state).toBe(
        "revoked",
      ),
    );
    expect(revokeAdminInvite).toHaveBeenCalledWith(INVITE.id);
    await revoke.unmount();
    queryClient.clear();
  });

  test("a test email is prepended to the redacted email log", async () => {
    jest.mocked(sendAdminTestEmail).mockResolvedValue(EMAIL);
    const { queryClient, wrapper } = harness();
    const mutation = await renderHook(() => useSendAdminTestEmailMutation(), { wrapper });
    await act(async () => {
      await mutation.result.current.mutateAsync({ to: null });
    });
    expect(sendAdminTestEmail).toHaveBeenCalledWith({ to: null });
    expect(queryClient.getQueryData(qk.adminEmails())).toEqual([EMAIL]);
    await mutation.unmount();
    queryClient.clear();
  });
});
