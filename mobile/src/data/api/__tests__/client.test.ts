import { z } from "zod";

const mockTokenState: { value: string | null } = { value: null };

jest.mock("@/data/api/auth-token", () => ({
  authToken: {
    get: jest.fn(async () => mockTokenState.value),
    set: jest.fn(async (token: string) => {
      mockTokenState.value = token;
    }),
    clear: jest.fn(async () => {
      mockTokenState.value = null;
    }),
    captureFromResponse: jest.fn(async () => null),
  },
}));

jest.mock("@/data/api/config", () => ({
  getBaseUrl: jest.fn(async () => "https://api.spawn.test"),
}));

import { authToken } from "@/data/api/auth-token";
import { api, subscribeUnauthenticated } from "@/data/api/client";

const fetchMock = jest.fn();

function mockResponse(
  status: number,
  body: unknown = undefined,
  options: { statusText?: string; jsonError?: Error } = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: options.statusText ?? "",
    headers: { get: () => null } as unknown as Headers,
    json: options.jsonError
      ? jest.fn(async () => {
          throw options.jsonError;
        })
      : jest.fn(async () => body),
    text: jest.fn(async () => String(body)),
    arrayBuffer: jest.fn(async () => new ArrayBuffer(0)),
  } as unknown as Response;
}

beforeAll(() => {
  globalThis.fetch = fetchMock as typeof fetch;
});

beforeEach(() => {
  fetchMock.mockReset();
  jest.mocked(authToken.clear).mockClear();
  mockTokenState.value = null;
  fetchMock.mockResolvedValue(mockResponse(200, { ok: true }));
});

it("injects bearer and JSON headers when a token exists", async () => {
  mockTokenState.value = "long-session-token";
  await api("/api/me");
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  const headers = init.headers as Headers;
  expect(url).toBe("https://api.spawn.test/api/me");
  expect(headers.get("Authorization")).toBe("Bearer long-session-token");
  expect(headers.get("Accept")).toBe("application/json");
  expect(headers.get("Content-Type")).toBe("application/json");
});

it("omits authorization when no token exists", async () => {
  await api("/healthz");
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect((init.headers as Headers).has("Authorization")).toBe(false);
});

it("honors caller header overrides", async () => {
  await api("/upload", {
    headers: { Accept: "text/plain", "Content-Type": "application/octet-stream" },
  });
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  const headers = init.headers as Headers;
  expect(headers.get("Accept")).toBe("text/plain");
  expect(headers.get("Content-Type")).toBe("application/octet-stream");
});

it("maps a coded error body", async () => {
  fetchMock.mockResolvedValue(mockResponse(409, { code: "workspace_full", message: "No room" }));
  await expect(api("/api/workspaces")).rejects.toMatchObject({
    status: 409,
    code: "workspace_full",
    message: "No room",
  });
});

it("uses a FastAPI detail string as the message", async () => {
  fetchMock.mockResolvedValue(mockResponse(404, { detail: "host not found" }));
  await expect(api("/api/hosts/missing")).rejects.toMatchObject({
    status: 404,
    code: "http_404",
    message: "host not found",
    detail: "host not found",
  });
});

it("maps an unparseable error body", async () => {
  fetchMock.mockResolvedValue(
    mockResponse(500, undefined, {
      statusText: "Internal Server Error",
      jsonError: new Error("not json"),
    }),
  );
  await expect(api("/broken")).rejects.toMatchObject({
    status: 500,
    code: "http_500",
    message: "Internal Server Error",
  });
});

it("resolves a 204 response to undefined", async () => {
  fetchMock.mockResolvedValue(mockResponse(204));
  await expect(api<void>("/api/auth/logout", { method: "POST" })).resolves.toBeUndefined();
});

it("throws ApiError and logs zod issues on a schema mismatch", async () => {
  fetchMock.mockResolvedValue(mockResponse(200, { value: "wrong" }));
  const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
  const result = api("/typed", { schema: z.object({ value: z.number() }) });
  await expect(result).rejects.toMatchObject({ status: 200, code: "schema_mismatch" });
  expect(consoleError).toHaveBeenCalledWith(
    "Spawn API schema mismatch",
    expect.objectContaining({ path: "/typed", issues: expect.any(Array) }),
  );
  consoleError.mockRestore();
});

it("aborts a stalled request at the configured timeout", async () => {
  jest.useFakeTimers();
  fetchMock.mockImplementation(
    async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
  const request = api("/slow", { timeoutMs: 25 });
  const assertion = expect(request).rejects.toEqual(
    expect.objectContaining({ status: 0, code: "timeout" }),
  );
  await jest.advanceTimersByTimeAsync(25);
  await assertion;
  jest.useRealTimers();
});

it("clears auth and emits one unauthenticated event for repeated 401s", async () => {
  mockTokenState.value = "expired-token";
  fetchMock.mockResolvedValue(mockResponse(401, { detail: "expired" }));
  const listener = jest.fn();
  const unsubscribe = subscribeUnauthenticated(listener);

  await expect(api("/first")).rejects.toMatchObject({ status: 401, code: "http_401" });
  await expect(api("/second")).rejects.toMatchObject({ status: 401, code: "http_401" });

  expect(authToken.clear).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
});
