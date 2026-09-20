import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { getHost } from "@/data/api/endpoints/hosts";
import { getSession } from "@/data/api/endpoints/sessions";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { useTerminalData } from "@/data/queries/terminal";
import { qk } from "@/data/queryKeys";

jest.mock("@/data/api/endpoints/hosts", () => ({ getHost: jest.fn() }));
jest.mock("@/data/api/endpoints/sessions", () => ({ getSession: jest.fn() }));
jest.mock("@/data/queries/session-teardown", () => ({}));

const session = { id: "session", host_id: "host", status: "running" } as SessionOut;
const host = { id: "host", host_public_key: "key", status: "online" } as HostOut;
let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  jest.clearAllMocks();
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 10_000, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  jest.mocked(getSession).mockImplementation(() => new Promise(() => {}));
  jest.mocked(getHost).mockImplementation(() => new Promise(() => {}));
});
afterEach(() => client.clear());

test("first open has session and host immediately, with no serial detail requests", async () => {
  const updatedAt = Date.now() - 1_000;
  client.setQueryData(qk.sessionsForHost(host.id), [session], { updatedAt });
  client.setQueryData([...qk.hosts(), "daemon-connections", "account"], [host], { updatedAt });
  expect(client.getQueryData(qk.session(session.id))).toBeUndefined();
  expect(client.getQueryData(qk.host(host.id))).toBeUndefined();
  const { result } = await renderHook(() => useTerminalData(session.id), { wrapper });
  expect(result.current).toMatchObject({ session, host, isLoading: false, error: null });
  expect(getSession).not.toHaveBeenCalled();
  expect(getHost).not.toHaveBeenCalled();
  expect(client.getQueryState(qk.session(session.id))?.dataUpdatedAt).toBe(updatedAt);
});

test("stale list data starts real detail queries rather than renewing its age", async () => {
  client.setQueryData(qk.sessions(), [session], { updatedAt: Date.now() - 60_000 });
  const { result } = await renderHook(() => useTerminalData(session.id), { wrapper });
  expect(result.current.isLoading).toBe(true);
  expect(result.current.session).toBeUndefined();
  expect(getSession).toHaveBeenCalledWith(session.id);
});

test("invalidated and removed account data cannot seed a terminal", async () => {
  client.setQueryData(qk.sessions(), [session]);
  await client.invalidateQueries({ queryKey: qk.sessions() });
  const first = await renderHook(() => useTerminalData(session.id), { wrapper });
  expect(first.result.current.session).toBeUndefined();
  await first.unmount();
  await act(() => client.clear());
  const next = await renderHook(() => useTerminalData(session.id), { wrapper });
  expect(next.result.current.session).toBeUndefined();
  expect(next.result.current.host).toBeUndefined();
});
