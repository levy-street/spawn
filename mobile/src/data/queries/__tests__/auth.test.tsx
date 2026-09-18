import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { authToken } from "@/data/api/auth-token";
import type { MeResponse } from "@/data/api/schemas/auth";
import { confirmEmailOnce, useLoginMutation } from "@/data/queries/auth";
import { qk } from "@/data/queryKeys";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "person@example.com",
  created_at: "2026-08-22T00:00:00Z",
  email_verified_at: "2026-08-22T00:00:00Z",
  is_admin: false,
};

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      mutations: { gcTime: Number.POSITIVE_INFINITY, retry: false },
      queries: { gcTime: Number.POSITIVE_INFINITY, retry: false },
    },
  });
}

describe("useLoginMutation", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("captures the response cookie and seeds the me query without storing access_token", async () => {
    const queryClient = createQueryClient();
    const response = new Response(JSON.stringify({ access_token: "short-token", user: USER }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": "spawn_session=long-token" },
    });
    jest.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const capture = jest.spyOn(authToken, "captureFromResponse");
    const set = jest.spyOn(authToken, "set");
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result, unmount } = await renderHook(() => useLoginMutation(), { wrapper });
    queryClient.setQueryData(qk.hosts(), [{ id: "previous-account-host" }]);

    await act(async () => {
      await result.current.mutateAsync({ email: USER.email, password: "correct horse" });
    });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalledWith("short-token");
    expect(queryClient.getQueryData<MeResponse>(qk.me())).toEqual({ user: USER });
    expect(queryClient.getQueryData(qk.hosts())).toBeUndefined();
    await unmount();
    queryClient.clear();
  });

  it("confirms each verification token only once per app process", async () => {
    const response = new Response(JSON.stringify({ user: USER }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fetch = jest.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const first = confirmEmailOnce("unique-token-1234567890");
    const second = confirmEmailOnce("unique-token-1234567890");

    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ user: USER });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
