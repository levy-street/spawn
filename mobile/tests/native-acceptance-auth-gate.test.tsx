import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { AppState } from "react-native";
import { authToken } from "@/data/api/auth-token";
import { setBaseUrl } from "@/data/api/config";
import { useLoginMutation, useMeQuery } from "@/data/queries/auth";
import { qk } from "@/data/queryKeys";
import { AuthGate, useAuthenticatedAccount } from "@/lib/auth-gate";
import { AppProviders } from "@/lib/providers";
import { NativeAcceptanceController } from "../e2e/native-controller";

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: {
        nativeAcceptance: {
          token: "t".repeat(32),
          candidateCommit: "candidate",
          sourceClean: true,
        },
      },
    },
  },
}));
jest.mock("expo-network", () => ({
  getNetworkStateAsync: async () => ({
    isConnected: true,
    isInternetReachable: true,
    type: "WIFI",
  }),
  addNetworkStateListener: () => ({ remove: jest.fn() }),
}));
jest.mock("expo-font", () => ({ useFonts: () => [true, null] }));
jest.mock("expo-splash-screen", () => ({ hideAsync: async () => {} }));
jest.mock("expo-system-ui", () => ({ setBackgroundColorAsync: async () => {} }));
jest.mock("expo-router", () => ({
  router: { replace: jest.fn() },
  usePathname: () => "/workspaces",
  useRouter: () => ({ replace: jest.fn() }),
}));
jest.mock("@/lib/push", () => ({ unregisterForPushNotifications: jest.fn(async () => {}) }));
jest.mock(
  "react-native-safe-area-context",
  () => require("react-native-safe-area-context/jest/mock").default,
);
jest.mock("react-native-keyboard-controller", () => ({
  KeyboardProvider: ({ children }: PropsWithChildren) => children,
}));
jest.mock("@/components/ui/toast", () => ({
  ToastProvider: ({ children }: PropsWithChildren) => children,
}));
jest.mock("@/components/ui/confirm", () => ({ ConfirmHost: () => null }));
jest.mock("@/components/media/camera-host", () => ({ CameraHost: () => null }));
jest.mock("@/lib/release-watcher", () => ({ ReleaseWatcher: () => null }));
jest.mock("@/data/realtime/alert-socket", () => ({
  AlertSocketClient: class {
    state = "idle";
    connect() {}
    close() {}
    retire() {}
    hardReconnect() {}
    subscribe() {
      return () => {};
    }
    onFrame() {
      return () => {};
    }
  },
}));
jest.mock("@/terminal/HostTransportSurface", () => ({ HostTransportSurface: () => null }));
jest.mock("@/terminal/TerminalSurface", () => ({ TerminalSurface: () => null }));
jest.mock("@/data/trust/registration", () => ({
  ensureDeviceRegistered: async () => ({ id: "registered-device" }),
}));
jest.mock("@/lib/crypto/identity", () => ({
  deviceIdentity: {
    ensure: async () => ({ publicKey: new Uint8Array(32).fill(7), deviceId: "local-key" }),
  },
  deviceIdentityGeneration: () => 1,
  setDeviceIdentityAccount: jest.fn(),
  clearDeviceIdentityAccount: jest.fn(),
  activeDeviceIdentityAccount: () => "11111111-1111-4111-8111-111111111111",
  subscribeDeviceIdentityAccount: () => () => {},
  onDeviceIdentityReset: () => () => {},
}));
const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "fixture@example.com",
  created_at: "2026-09-01T00:00:00Z",
  email_verified_at: "2026-09-01T00:00:00Z",
  is_admin: false,
};
const CONFIG = { providers: [], email_verification_required: false, invite_only: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("a restored native login reaches acceptance without retiring its ready account", async () => {
  jest.useFakeTimers();
  await setBaseUrl("http://127.0.0.1:18100");
  await authToken.clear();
  await authToken.set("fixture-token");
  const credentialChanged = jest.fn();
  const unsubscribe = authToken.subscribe(credentialChanged);
  const bootstrap = deferred<Response>();
  let client!: QueryClient;
  let account = { accountId: null as string | null, ready: false };
  const events: Array<{ type: string; status: string }> = [];
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/__acceptance/bootstrap") return bootstrap.promise;
    if (path === "/__acceptance/event") {
      events.push(JSON.parse(String(init?.body)));
      return response(null);
    }
    if (path === "/__acceptance/device") return response({ approved: true });
    if (path === "/__acceptance/command") return response(null);
    if (path === "/api/auth/config") return response(CONFIG);
    if (path === "/api/hosts") return response([]);
    if (path === "/api/me") return response({ user: USER });
    throw new Error(`Unexpected request: ${path}`);
  });
  function Observe() {
    client = useQueryClient();
    account = useAuthenticatedAccount();
    return null;
  }
  const view = await render(
    <AppProviders>
      <AuthGate>
        <Observe />
        <NativeAcceptanceController />
      </AuthGate>
    </AppProviders>,
  );
  try {
    // On process relaunch, the real gate can restore the stored login before
    // the controller receives its bootstrap response. Preserve that identity.
    await waitFor(() => expect(account).toEqual({ accountId: USER.id, ready: true }));
    const resetQueries = jest.spyOn(client, "resetQueries");
    await act(async () => {
      bootstrap.resolve(
        response({
          accountId: USER.id,
          bearerToken: "fixture-token",
          candidateCommit: "candidate",
        }),
      );
    });
    await waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ type: "boot", status: "passed" })),
    );
    expect(credentialChanged).not.toHaveBeenCalled();
    expect(resetQueries).not.toHaveBeenCalled();
    expect(account).toEqual({ accountId: USER.id, ready: true });
    resetQueries.mockRestore();
  } finally {
    await view.unmount();
    client.clear();
    fetch.mockRestore();
    unsubscribe();
    await authToken.clear();
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("native controller boots through real app providers while gate queries are already mounted", async () => {
  jest.useFakeTimers();
  await setBaseUrl("http://127.0.0.1:18100");
  await authToken.clear();
  let client!: QueryClient;
  let account = { accountId: null as string | null, ready: false };
  const events: Array<{ type: string; status: string }> = [];
  const config = deferred<Response>();
  const meReady = deferred<void>();
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/__acceptance/bootstrap")
      return response({
        accountId: USER.id,
        bearerToken: "fixture-token",
        candidateCommit: "candidate",
      });
    if (path === "/__acceptance/event") {
      events.push(JSON.parse(String(init?.body)));
      return response(null);
    }
    if (path === "/__acceptance/device") return response({ approved: true });
    if (path === "/__acceptance/command") return response(null);
    if (path === "/api/auth/config") return config.promise.then((value) => value.clone());
    if (path === "/api/hosts") return response([]);
    if (path === "/api/me") {
      const authenticated = new Headers(init?.headers).has("Authorization");
      if (authenticated) await meReady.promise;
      return authenticated ? response({ user: USER }) : response({ detail: "not signed in" }, 401);
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  function Observe() {
    client = useQueryClient();
    account = useAuthenticatedAccount();
    // The mounted navigator can request account data before fixture login.
    useMeQuery();
    return null;
  }
  const view = await render(
    <AppProviders>
      <AuthGate>
        <Observe />
        <NativeAcceptanceController />
      </AuthGate>
    </AppProviders>,
  );
  try {
    await waitFor(() =>
      expect(fetch.mock.calls.some(([input]) => String(input).endsWith("/api/auth/config"))).toBe(
        true,
      ),
    );
    await act(async () => {
      meReady.resolve();
    });
    await waitFor(() => expect(client.getQueryData(qk.me())).toEqual({ user: USER }));
    await expect(authToken.get()).resolves.toBe("fixture-token");
    expect(client.getQueryData(qk.me())).toEqual({ user: USER });
    await act(async () => {
      config.resolve(response(CONFIG));
    });
    await waitFor(() => expect(account).toEqual({ accountId: USER.id, ready: true }));
    await waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ type: "boot", status: "passed" })),
    );
  } finally {
    config.resolve(response(CONFIG));
    await view.unmount();
    client.clear();
    fetch.mockRestore();
    await authToken.clear();
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("normal login retains real AuthGate queries across delayed login and config responses", async () => {
  jest.useFakeTimers();
  await setBaseUrl("http://127.0.0.1:18100");
  await authToken.clear();
  let client!: QueryClient;
  let account = { accountId: null as string | null, ready: false };
  let mutation!: ReturnType<typeof useLoginMutation>;
  const config = deferred<void>();
  const loginBody = deferred<unknown>();
  let configRequested = false;
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/auth/login") {
      const loginResponse = response({});
      loginResponse.headers.set("set-cookie", "spawn_session=fixture-login");
      jest.spyOn(loginResponse, "json").mockReturnValue(loginBody.promise);
      return loginResponse;
    }
    if (path === "/api/auth/config") {
      configRequested = true;
      await config.promise;
      return response(CONFIG);
    }
    if (path === "/api/me") return response({ user: USER });
    if (path === "/api/hosts") return response([]);
    throw new Error(`Unexpected request: ${path}`);
  });
  function Login() {
    client = useQueryClient();
    account = useAuthenticatedAccount();
    mutation = useLoginMutation();
    return null;
  }
  const view = await render(
    <AppProviders>
      <AuthGate>
        <Login />
      </AuthGate>
    </AppProviders>,
  );
  try {
    let login!: Promise<unknown>;
    await act(async () => {
      login = mutation.mutateAsync({ email: USER.email, password: "correct horse" });
    });
    await waitFor(() => expect(configRequested).toBe(true));
    await act(async () => {
      loginBody.resolve({ access_token: "short-token", user: USER });
      await login;
    });
    await act(async () => {
      config.resolve();
    });
    await waitFor(() => expect(account).toEqual({ accountId: USER.id, ready: true }));
  } finally {
    config.resolve();
    loginBody.resolve({ access_token: "short-token", user: USER });
    await view.unmount();
    client.clear();
    fetch.mockRestore();
    await authToken.clear();
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test("repeated native account switches clear the previous account before installing its replacement token", async () => {
  jest.useFakeTimers();
  const previousAppState = AppState.currentState;
  AppState.currentState = "active";
  await setBaseUrl("http://127.0.0.1:18100");
  await authToken.clear();
  const other = { ...USER, id: "22222222-2222-4222-8222-222222222222", email: "other@example.com" };
  let client!: QueryClient;
  let account = { accountId: null as string | null, ready: false };
  let command: { id: string; action: string; payload: { account: string } } | null = null;
  const events: Array<{ type: string; status: string; commandId?: string }> = [];
  const priorAccountCache: unknown[] = [];
  let bootstrapped = false;
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/__acceptance/bootstrap") {
      if (bootstrapped) priorAccountCache.push(client.getQueryData(["previous-account-private"]));
      bootstrapped = true;
      return response({
        accountId: USER.id,
        bearerToken: "fixture-a",
        candidateCommit: "candidate",
        secondAccount: { accountId: other.id, bearerToken: "fixture-b" },
      });
    }
    if (path === "/__acceptance/event") {
      events.push(JSON.parse(String(init?.body)));
      return response(null);
    }
    if (path === "/__acceptance/device") return response({ approved: true });
    if (path === "/__acceptance/command") {
      const next = command;
      command = null;
      return response(next);
    }
    if (path === "/api/auth/logout") return new Response(null, { status: 204 });
    if (path === "/api/auth/config") return response(CONFIG);
    if (path === "/api/hosts") return response([]);
    if (path === "/api/me") {
      const token = new Headers(init?.headers).get("Authorization");
      if (token === "Bearer fixture-a") return response({ user: USER });
      if (token === "Bearer fixture-b") return response({ user: other });
      return response({ detail: "not signed in" }, 401);
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  function Observe() {
    client = useQueryClient();
    account = useAuthenticatedAccount();
    return null;
  }
  const view = await render(
    <AppProviders>
      <AuthGate>
        <Observe />
        <NativeAcceptanceController />
      </AuthGate>
    </AppProviders>,
  );
  try {
    await waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ type: "boot", status: "passed" })),
    );
    for (const [index, next] of ["b", "a", "b", "a"].entries()) {
      client.setQueryData(["previous-account-private"], { owner: account.accountId });
      const id = `switch-${index}`;
      command = { id, action: "switch-account", payload: { account: next } };
      await waitFor(
        () => expect(events.find((event) => event.commandId === id)?.status).toBe("passed"),
        { timeout: 5_000 },
      );
      expect(account).toEqual({ accountId: next === "a" ? USER.id : other.id, ready: true });
      // Inspect at the next bootstrap, before account adoption could hide stale
      // data by clearing it later. The UI's sign-out action already does this.
      expect(priorAccountCache).toEqual(Array(index + 1).fill(undefined));
    }
  } finally {
    await view.unmount();
    client.clear();
    fetch.mockRestore();
    await authToken.clear();
    AppState.currentState = previousAppState;
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});
