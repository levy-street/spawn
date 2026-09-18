import * as SecureStore from "expo-secure-store";
import { authToken } from "@/data/api/auth-token";
import { api } from "@/data/api/client";
import * as config from "@/data/api/config";

const stored = new Map<string, string>();
const fetchMock = jest.fn();
let sequence = 0;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function response(status: number, cookie: string | null = null): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "fixture",
    headers: {
      get: (name: string) => (name.toLowerCase() === "set-cookie" ? cookie : null),
    } as Headers,
    json: async () => ({ detail: "fixture" }),
  } as Response;
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(async () => {
  jest.restoreAllMocks();
  jest.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => stored.get(key) ?? null);
  jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    stored.set(key, value);
  });
  jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    stored.delete(key);
  });
  stored.clear();
  await config.setBaseUrl(`https://review-${++sequence}.spawn.test`);
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as typeof fetch;
});

test("a pre-login 401 cannot clear the newly installed token", async () => {
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  const request = api("/api/workspaces").catch((error: unknown) => error);
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await authToken.set("new-login");
  pending.resolve(response(401));
  await request;
  await expect(authToken.get()).resolves.toBe("new-login");
});

test("a prior account's sliding cookie cannot replace the current token", async () => {
  await authToken.set("account-a");
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  const request = api("/api/workspaces");
  await flush();
  await authToken.set("account-b");
  pending.resolve(response(200, "spawn_session=account-a-renewed; Path=/"));
  await request;
  await expect(authToken.get()).resolves.toBe("account-b");
});

test("a response from the previous origin cannot install its cookie at the new origin", async () => {
  await authToken.set("server-a");
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  const request = api("/api/workspaces");
  await flush();
  await config.setBaseUrl(`https://replacement-${sequence}.spawn.test`);
  await authToken.set("server-b");
  pending.resolve(response(200, "spawn_session=server-a-renewed; Path=/"));
  await request;
  await expect(authToken.get()).resolves.toBe("server-b");
});

test("request URL and bearer come from the same origin snapshot", async () => {
  const originA = await config.getBaseUrl();
  await authToken.set("server-a");
  jest
    .spyOn(config, "getBaseUrl")
    .mockResolvedValueOnce(originA)
    .mockResolvedValue("https://server-b.spawn.test");
  fetchMock.mockResolvedValue(response(200));
  await api("/api/workspaces");
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  if (url.startsWith("https://server-b.spawn.test")) {
    expect((init.headers as Headers).get("Authorization")).not.toBe("Bearer server-a");
  } else {
    expect(url).toBe(`${originA}/api/workspaces`);
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer server-a");
  }
});

test("a late empty SecureStore read cannot overwrite a newly persisted token", async () => {
  const nativeRead = deferred<string | null>();
  jest.mocked(SecureStore.getItemAsync).mockReturnValueOnce(nativeRead.promise);
  const reading = authToken.get();
  await flush();
  await authToken.set("new-login");
  nativeRead.resolve(null);
  await reading;
  await expect(authToken.get()).resolves.toBe("new-login");
});

test("a delayed older persistence write cannot restore a token after logout", async () => {
  const nativeWrite = deferred<void>();
  jest.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
    await nativeWrite.promise;
    stored.set(key, value);
  });
  const setting = authToken.set("old-login");
  await flush();
  const clearing = authToken.clear();
  await flush();
  nativeWrite.resolve();
  await Promise.all([setting, clearing]);
  await expect(authToken.get()).resolves.toBeNull();
  expect(stored.size).toBe(0);
});

test("a delayed old clear cannot erase a newer persisted login", async () => {
  await authToken.set("old-login");
  const nativeDelete = deferred<void>();
  jest.mocked(SecureStore.deleteItemAsync).mockImplementationOnce(async (key) => {
    await nativeDelete.promise;
    stored.delete(key);
  });
  const clearing = authToken.clear();
  await flush();
  const setting = authToken.set("new-login");
  await flush();
  nativeDelete.resolve();
  await Promise.all([clearing, setting]);
  await expect(authToken.get()).resolves.toBe("new-login");
  expect([...stored.values()].map((value) => JSON.parse(value).jwt)).toEqual(["new-login"]);
});

test("a deliberate login still persists after an unrelated sliding renewal", async () => {
  await authToken.set("account-a");
  const loginResponse = deferred<Response>();
  const renewalResponse = deferred<Response>();
  fetchMock.mockReturnValueOnce(loginResponse.promise).mockReturnValueOnce(renewalResponse.promise);
  const login = api("/api/auth/login", { method: "POST", auth: false, replaceSession: true });
  await flush();
  const renewal = api("/api/workspaces");
  await flush();
  renewalResponse.resolve(response(200, "spawn_session=account-a-renewed; Path=/"));
  await renewal;
  loginResponse.resolve(response(200, "spawn_session=deliberate-account-b; Path=/"));
  await login;
  await expect(authToken.get()).resolves.toBe("deliberate-account-b");
});

test("an old anonymous login response cannot resurrect after logout", async () => {
  const loginResponse = deferred<Response>();
  fetchMock.mockReturnValueOnce(loginResponse.promise);
  const login = api("/api/auth/login", { method: "POST", auth: false, replaceSession: true });
  await flush();
  await authToken.clear();
  loginResponse.resolve(response(200, "spawn_session=old-login; Path=/"));
  await expect(login).rejects.toMatchObject({ code: "auth_changed" });
  await expect(authToken.get()).resolves.toBeNull();
});

jest.mock("@/lib/push", () => ({ unregisterForPushNotifications: jest.fn() }));

test("logout clears its same-account token after unregister renews it", async () => {
  const { logOut } =
    require("@/data/api/endpoints/auth") as typeof import("@/data/api/endpoints/auth");
  const push = require("@/lib/push") as typeof import("@/lib/push");
  jest.mocked(push.unregisterForPushNotifications).mockImplementationOnce(async () => {
    await api("/api/push/unregister", { method: "POST" });
  });
  await authToken.set("old-login");
  fetchMock.mockResolvedValueOnce(response(200, "spawn_session=renewed-same-account; Path=/"));
  fetchMock.mockResolvedValueOnce(response(204));
  await logOut();
  await expect(authToken.get()).resolves.toBeNull();
});

test("a socket1008 from the previous token cannot clear a new login", async () => {
  const { ReconnectingSocket } =
    require("@/data/realtime/socket") as typeof import("@/data/realtime/socket");
  await authToken.set("old-socket-login");
  const baseUrl = await config.getBaseUrl();
  const native = {
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
    protocol: "spawn.host.v1",
    readyState: 1,
    close: jest.fn(),
    send: jest.fn(),
  } as unknown as WebSocket;
  const made = jest.fn(() => native);
  const socket = new ReconnectingSocket({
    url: () => `${baseUrl.replace("https:", "wss:")}/ws/host`,
    protocol: "spawn.host.v1",
    authorization: () => authToken.snapshot(),
    createWebSocket: made,
  });
  try {
    socket.connect();
    await flush();
    expect(made).toHaveBeenCalledTimes(1);
    await authToken.set("new-login");
    native.onclose?.call(native, { code: 1008 } as CloseEvent);
    await flush();
    await expect(authToken.get()).resolves.toBe("new-login");
  } finally {
    socket.close();
  }
});

function renewableJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  return `h.${btoa(JSON.stringify({ iat: now - 120, exp: now + 60 }))}.s`;
}
function renewalResponse(cookie: string | null, token: string): Response {
  return {
    ...response(200, cookie),
    json: async () => ({ access_token: token, expires_at: "2030-01-01T00:00:00Z" }),
  };
}

test("real SessionRenewal does not persist its cookie and body twice", async () => {
  const { renewSessionIfNeeded } =
    require("@/lib/session-renewal") as typeof import("@/lib/session-renewal");
  await authToken.set(renewableJwt());
  jest.mocked(SecureStore.setItemAsync).mockClear();
  fetchMock.mockResolvedValueOnce(
    renewalResponse("spawn_session=renewed-long-token; Path=/", "renewed-long-token"),
  );
  await expect(renewSessionIfNeeded()).resolves.toBe("renewed");
  await expect(authToken.get()).resolves.toBe("renewed-long-token");
  expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
});

test("body-only session renewal cannot suppress a deliberate login", async () => {
  const { renewSessionIfNeeded } =
    require("@/lib/session-renewal") as typeof import("@/lib/session-renewal");
  await authToken.set(renewableJwt());
  const loginResponse = deferred<Response>();
  const bodyResponse = deferred<Response>();
  fetchMock.mockReturnValueOnce(loginResponse.promise).mockReturnValueOnce(bodyResponse.promise);
  const login = api("/api/auth/login", { method: "POST", auth: false, replaceSession: true });
  await flush();
  const renewal = renewSessionIfNeeded();
  await flush();
  bodyResponse.resolve(renewalResponse(null, "renewed-same-account"));
  await renewal;
  loginResponse.resolve(response(200, "spawn_session=deliberate-new-login; Path=/"));
  await login;
  await expect(authToken.get()).resolves.toBe("deliberate-new-login");
});

test("a stale body-only session renewal cannot overwrite a new login", async () => {
  const { renewSessionIfNeeded } =
    require("@/lib/session-renewal") as typeof import("@/lib/session-renewal");
  await authToken.set(renewableJwt());
  const bodyResponse = deferred<Response>();
  fetchMock.mockReturnValueOnce(bodyResponse.promise);
  const renewal = renewSessionIfNeeded();
  await flush();
  await authToken.set("new-login");
  bodyResponse.resolve(renewalResponse(null, "renewed-old-account"));
  await renewal;
  await expect(authToken.get()).resolves.toBe("new-login");
});

test("an old authenticated request cannot clear a replacement account on 401", async () => {
  await authToken.set("old-account");
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  const request = api("/api/workspaces").catch((error: unknown) => error);
  await flush();
  await authToken.set("new-account");
  pending.resolve(response(401));
  await request;
  await expect(authToken.get()).resolves.toBe("new-account");
});

test("simultaneous current-session refusals notify signed-out consumers once", async () => {
  const { subscribeUnauthenticated } =
    require("@/data/api/client") as typeof import("@/data/api/client");
  await authToken.set("refused-session");
  const pending = deferred<Response>();
  fetchMock.mockReturnValue(pending.promise);
  const listener = jest.fn();
  const unsubscribe = subscribeUnauthenticated(listener);
  try {
    const requests = [api("/api/workspaces"), api("/api/hosts")].map((request) =>
      request.catch((error: unknown) => error),
    );
    await flush();
    pending.resolve(response(401));
    await Promise.all(requests);
    await expect(authToken.get()).resolves.toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
  }
});

test.each(["host", "session", "alerts"] as const)(
  "%s socket URL and bearer stay bound across a server switch during startup",
  async (kind) => {
    const { openHostSignal } =
      require("@/data/realtime/host-signal") as typeof import("@/data/realtime/host-signal");
    const { openSessionSignal } =
      require("@/data/realtime/session-signal") as typeof import("@/data/realtime/session-signal");
    const { AlertSocketClient } =
      require("@/data/realtime/alert-socket") as typeof import("@/data/realtime/alert-socket");
    const { buildAlertsSocketUrl } =
      require("@/data/api/socket-urls") as typeof import("@/data/api/socket-urls");
    const originA = await config.getBaseUrl();
    await authToken.set("server-a");
    const native = { close: jest.fn() } as unknown as WebSocket;
    const make = jest.spyOn(globalThis, "WebSocket").mockImplementation(() => native);
    jest
      .spyOn(config, "getBaseUrl")
      .mockResolvedValueOnce(originA)
      .mockResolvedValue("https://server-b.spawn.test");
    const channel =
      kind === "host"
        ? openHostSignal("host-fixture")
        : kind === "session"
          ? openSessionSignal("session-fixture")
          : new AlertSocketClient(buildAlertsSocketUrl);
    try {
      if (channel instanceof AlertSocketClient) channel.connect();
      await flush();
      expect(make).toHaveBeenCalledTimes(1);
      expect(make.mock.calls[0]).toEqual([
        expect.stringMatching(new RegExp(`^${originA.replace("https:", "wss:")}/ws/`)),
        expect.any(String),
        { headers: { Authorization: "Bearer server-a" } },
      ]);
    } finally {
      channel.close();
    }
  },
);

test.each(["logout", "delete-account", "sign-out-everywhere"] as const)(
  "a late %s response cannot change a newer login",
  async (operation) => {
    const { logOut, signOutEverywhere } =
      require("@/data/api/endpoints/auth") as typeof import("@/data/api/endpoints/auth");
    const { deleteAccount } =
      require("@/data/api/endpoints/account") as typeof import("@/data/api/endpoints/account");
    await authToken.set("old-account");
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const request =
      operation === "logout"
        ? logOut()
        : operation === "delete-account"
          ? deleteAccount({ confirm_email: "owner@example.com", password: null })
          : signOutEverywhere();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await authToken.set("new-account");
    pending.resolve(
      operation === "sign-out-everywhere"
        ? { ...response(200), json: async () => ({ access_token: "old-account-rotated" }) }
        : response(204),
    );
    await request;
    await expect(authToken.get()).resolves.toBe("new-account");
  },
);

test("public health request does not require available SecureStore", async () => {
  jest.mocked(SecureStore.getItemAsync).mockRejectedValue(new Error("SecureStore unavailable"));
  fetchMock.mockResolvedValueOnce(response(200));
  await expect(api("/healthz", { auth: false })).resolves.toEqual({ detail: "fixture" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect((fetchMock.mock.calls[0][1].headers as Headers).get("Authorization")).toBeNull();
});

test("an in-flight public config response remains usable after login", async () => {
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  const request = api("/api/auth/config", { auth: false });
  await flush();
  await authToken.set("new-login");
  pending.resolve(response(200));
  await expect(request).resolves.toEqual({ detail: "fixture" });
  await expect(authToken.get()).resolves.toBe("new-login");
});
