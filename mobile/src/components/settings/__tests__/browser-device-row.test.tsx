import { fireEvent, render } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  BrowserDeviceRow,
  sortBrowserDevicesByLastSeen,
  staleBrowserDeviceLabel,
} from "@/components/settings/browser-device-row";
import type { BrowserDeviceOut } from "@/data/api/schemas/devices";
import { ThemeProvider } from "@/theme";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";

function device(overrides: Partial<BrowserDeviceOut> = {}): BrowserDeviceOut {
  return {
    id: DEVICE_ID,
    key_algorithm: "ed25519",
    public_key: "device-key",
    label: "Work phone",
    created_at: "2026-05-01T00:00:00Z",
    last_seen_at: "2026-08-25T00:55:00Z",
    approval_requested_at: null,
    revoked_at: null,
    revoked_by_device_id: null,
    is_root: false,
    ...overrides,
  };
}

describe("browser device hygiene", () => {
  afterEach(() => jest.useRealTimers());

  it("sorts live devices by last seen and badges only those beyond 60 days", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-25T01:00:00Z"));
    const recent = device({ id: "22222222-2222-4222-8222-222222222222" });
    const stale = device({
      id: "33333333-3333-4333-8333-333333333333",
      last_seen_at: "2026-06-01T00:00:00Z",
    });
    const never = device({
      id: "44444444-4444-4444-8444-444444444444",
      last_seen_at: null,
    });

    expect(sortBrowserDevicesByLastSeen([never, stale, recent]).map((item) => item.id)).toEqual([
      recent.id,
      stale.id,
      never.id,
    ]);
    expect(staleBrowserDeviceLabel(recent)).toBeNull();
    expect(staleBrowserDeviceLabel(stale)).toBe(
      `Not seen since ${new Date(stale.last_seen_at ?? "").toLocaleDateString()}`,
    );
  });

  it("renders last seen, waiting state, stale badge, and keeps Rename/Remove in actions", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-25T01:00:00Z"));
    const stale = device({ last_seen_at: "2026-06-01T00:00:00Z" });
    const screen = await render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
        }}
      >
        <ThemeProvider>
          <BrowserDeviceRow
            busy={false}
            canApprove
            current={false}
            device={stale}
            onApprove={jest.fn()}
            onRemove={jest.fn()}
            onRename={jest.fn()}
            trustedHostCount={0}
          />
        </ThemeProvider>
      </SafeAreaProvider>,
    );

    expect(screen.getByText("Seen 85d ago")).toBeOnTheScreen();
    expect(screen.getByText("Waiting for approval")).toBeOnTheScreen();
    expect(
      screen.getByText(`Not seen since ${new Date(stale.last_seen_at ?? "").toLocaleDateString()}`),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Options for Work phone" }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Remove" })).toBeOnTheScreen();
  });
});
