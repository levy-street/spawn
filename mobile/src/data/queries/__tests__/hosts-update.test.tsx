import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { getHost, updateHost } from "@/data/api/endpoints/hosts";
import type { HostOut, HostUpdateOut } from "@/data/api/schemas/hosts";
import { useHostUpdatePolling, useUpdateHost } from "@/data/queries/hosts";
import { qk } from "@/data/queryKeys";
import { makeHost } from "../../../../tests/factories";

jest.mock("@/data/api/endpoints/hosts", () => ({
  deleteHost: jest.fn(),
  getHost: jest.fn(),
  installHostAgent: jest.fn(),
  listHostAgents: jest.fn(),
  listHosts: jest.fn(),
  patchHost: jest.fn(),
  patchHostAgentPolicy: jest.fn(),
  updateHost: jest.fn(),
}));

const updating: HostUpdateOut = {
  state: "updating",
  latest_version: "0.1.0+gnew",
  error: null,
  requested_at: "2026-08-25T00:00:00Z",
};
const current: HostUpdateOut = {
  state: "current",
  latest_version: "0.1.0+gnew",
  error: null,
  requested_at: null,
};

const queryClients: QueryClient[] = [];

function harness() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      // MutationCache.clear() does not destroy its mutations' GC timers.
      mutations: { gcTime: Infinity },
    },
  });
  queryClients.push(queryClient);
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { queryClient, wrapper: Wrapper };
}

describe("host daemon update queries", () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(async () => {
    await cleanup();
    for (const queryClient of queryClients.splice(0)) queryClient.clear();
    jest.useRealTimers();
  });

  it("posts the update and patches both host cache shapes", async () => {
    const host = makeHost({ update: { ...updating, state: "available" } });
    jest.mocked(updateHost).mockResolvedValue({ update: updating });
    const { queryClient, wrapper } = harness();
    queryClient.setQueryData(qk.host(host.id), host);
    queryClient.setQueryData(qk.hosts(), [host]);
    const hook = await renderHook(() => useUpdateHost(host.id), { wrapper });

    await act(async () => {
      await hook.result.current.mutateAsync();
    });

    expect(updateHost).toHaveBeenCalledWith(host.id);
    expect(queryClient.getQueryData<HostOut>(qk.host(host.id))?.update).toEqual(updating);
    expect(queryClient.getQueryData<HostOut[]>(qk.hosts())?.[0]?.update).toEqual(updating);
  });

  it("polls an updating host every two seconds until it becomes current", async () => {
    jest.useFakeTimers();
    const host = makeHost({ update: updating });
    jest
      .mocked(getHost)
      .mockResolvedValueOnce({ ...host, update: updating })
      .mockResolvedValue({ ...host, update: current });
    const { wrapper } = harness();
    const hook = await renderHook(() => useHostUpdatePolling(host, true), { wrapper });
    await waitFor(() => expect(getHost).toHaveBeenCalledTimes(1));

    await act(async () => {
      jest.advanceTimersByTime(2_000);
      await Promise.resolve();
    });

    await waitFor(() => expect(hook.result.current.data?.update?.state).toBe("current"));
    expect(jest.mocked(getHost).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
