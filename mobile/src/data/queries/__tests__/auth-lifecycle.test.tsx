import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { authToken } from "@/data/api/auth-token";
import { setBaseUrl } from "@/data/api/config";
import type { MeResponse } from "@/data/api/schemas/auth";
import { useLoginMutation } from "@/data/queries/auth";
import { qk } from "@/data/queryKeys";

const USER_A = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "old@example.com",
  created_at: "2026-08-22T00:00:00Z",
  email_verified_at: "2026-08-22T00:00:00Z",
  is_admin: false,
};
const USER_B = { ...USER_A, id: "22222222-2222-4222-8222-222222222222", email: "new@example.com" };

test("late login success cannot replace the current account me cache", async () => {
  await setBaseUrl("https://hook-lifetime-review.spawn.test");
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { gcTime: Infinity, retry: false },
      queries: { gcTime: Infinity, retry: false },
    },
  });
  let respond!: (response: Response) => void;
  const deferredResponse = new Promise<Response>((resolve) => {
    respond = resolve;
  });
  const fetch = jest.spyOn(globalThis, "fetch").mockReturnValueOnce(deferredResponse);
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result, unmount } = await renderHook(() => useLoginMutation(), { wrapper });
  let login!: Promise<unknown>;
  try {
    await act(async () => {
      login = result.current
        .mutateAsync({ email: USER_A.email, password: "correct horse" })
        .catch((error: unknown) => error);
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await authToken.set("current-account-b");
      queryClient.setQueryData(qk.me(), { user: USER_B });
      respond(
        new Response(JSON.stringify({ access_token: "short-old", user: USER_A }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "spawn_session=old-account-a",
          },
        }),
      );
      await login;
    });
    await expect(authToken.get()).resolves.toBe("current-account-b");
    expect(queryClient.getQueryData<MeResponse>(qk.me())).toEqual({ user: USER_B });
  } finally {
    await unmount();
    queryClient.clear();
    fetch.mockRestore();
    await authToken.clear();
  }
});

test("login retired while decoding its accepted response cannot replace the current account me cache", async () => {
  await setBaseUrl("https://hook-body-lifetime-review.spawn.test");
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { gcTime: Infinity, retry: false },
      queries: { gcTime: Infinity, retry: false },
    },
  });
  let bodyReady!: (body: unknown) => void;
  const body = new Promise<unknown>((resolve) => {
    bodyReady = resolve;
  });
  const response = new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": "spawn_session=old-account-a" },
  });
  const decode = jest.spyOn(response, "json").mockReturnValueOnce(body);
  const fetch = jest.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result, unmount } = await renderHook(() => useLoginMutation(), { wrapper });
  let login!: Promise<unknown>;
  try {
    await act(async () => {
      login = result.current
        .mutateAsync({ email: USER_A.email, password: "correct horse" })
        .catch((error: unknown) => error);
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    expect(decode).toHaveBeenCalledTimes(1);
    await expect(authToken.get()).resolves.toBe("old-account-a");
    await act(async () => {
      await authToken.set("current-account-b");
      queryClient.setQueryData(qk.me(), { user: USER_B });
      bodyReady({ access_token: "short-old", user: USER_A });
      await login;
    });
    await expect(authToken.get()).resolves.toBe("current-account-b");
    expect(queryClient.getQueryData<MeResponse>(qk.me())).toEqual({ user: USER_B });
  } finally {
    await unmount();
    queryClient.clear();
    fetch.mockRestore();
    await authToken.clear();
  }
});
