import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react-native";

import { DeviceApprovalPrompt } from "@/components/trust/device-approval-prompt";
import { qk } from "@/data/queryKeys";
import { ThemeProvider } from "@/theme";

// #138: an approval this phone signs reaches the hosts that have CONFIRMED
// the way to this phone — the web's rule too. A host that has not confirmed
// still counts toward this phone being approved, but not toward what it can
// vouch for.

// The native modal is not what is under test: render its contents in place.
jest.mock("@/components/ui/dialog", () => ({
  ...(() => {
    const { View: MockView } = require("react-native") as typeof import("react-native");
    return {
      Dialog: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
        <MockView testID={testID}>{children}</MockView>
      ),
    };
  })(),
}));

jest.mock("@/data/api/endpoints/trust", () => ({
  listDeviceApprovals: async () => [
    {
      id: "00000000-0000-4000-8000-00000000eeee",
      browser_device_id: "00000000-0000-4000-8000-00000000dddd",
      label: "Chrome on Mac",
      fingerprint: "SHA256:aaaaaaaaaaaaaaaa",
      status: "pending",
      created_at: "2026-11-16T00:00:00Z",
      expires_at: "2099-01-01T00:00:00Z",
    },
  ],
  denyDeviceApproval: jest.fn(),
}));

jest.mock("@/data/queries/settings", () => ({
  useMeSettingsQuery: () => ({ data: { user: { id: "00000000-0000-4000-8000-00000000cccc" } } }),
}));

jest.mock("@/data/queries/pairing", () => ({
  useRegisteredPhone: () => ({
    data: { id: "00000000-0000-4000-8000-00000000bbbb", revoked_at: null },
    isSuccess: true,
  }),
  useAccountDevices: () => ({
    data: [
      { id: "00000000-0000-4000-8000-00000000bbbb", revoked_at: null },
      { id: "00000000-0000-4000-8000-00000000dddd", label: "Chrome on Mac", revoked_at: null },
    ],
  }),
}));

type Entry = { name: string; confirmed: boolean };
let mockApproved: Entry[] = [];
jest.mock("@/data/queries/device-trust", () => ({
  useDeviceHostApprovals: () => {
    const approved = mockApproved.map((entry, index) => ({
      host: { id: `host-${index}`, name: entry.name, host_public_key: "host-key" },
      trust: "trusted",
      confirmed: entry.confirmed,
    }));
    return { approvals: approved, approved, awaiting: [], resolved: true, refetch: jest.fn() };
  },
}));

jest.mock("@/data/trust/ceremony", () => ({
  useDeviceCeremony: () => ({
    ceremonies: [],
    error: null,
    start: jest.fn(),
    starting: false,
    submitDigits: jest.fn(),
    cancel: jest.fn(),
    dismiss: jest.fn(),
  }),
}));

async function renderPrompt() {
  // gcTime 0: the cache's garbage timer is an open handle jest waits out.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <DeviceApprovalPrompt />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return client;
}

describe("the knock prompt on a phone whose hosts have not all confirmed", () => {
  test("a phone approved only toward a host that has not confirmed offers nothing", async () => {
    mockApproved = [{ name: "office-mac", confirmed: false }];
    const client = await renderPrompt();
    // The knock has arrived and the prompt has rendered with it...
    await waitFor(() => expect(client.getQueryData(qk.deviceApprovals())).toHaveLength(1));
    await act(async () => {});
    // ...and stayed away: this phone has nothing it can vouch toward.
    expect(screen.queryByTestId("device-approval-prompt")).toBeNull();
  });

  test("it names only the hosts that have confirmed", async () => {
    mockApproved = [
      { name: "office-mac", confirmed: false },
      { name: "build-box", confirmed: true },
    ];
    await renderPrompt();
    expect(await screen.findByTestId("device-approval-prompt")).toBeOnTheScreen();
    expect(screen.getByText("build-box")).toBeOnTheScreen();
    expect(screen.queryByText(/office-mac/)).toBeNull();
  });
});
