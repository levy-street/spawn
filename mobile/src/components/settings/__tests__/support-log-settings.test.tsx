import { generateKeyPairSync, randomUUID } from "node:crypto";
import { NavigationContext } from "@react-navigation/native";
import { act, fireEvent, waitFor, within } from "@testing-library/react-native";
import type { ContextType } from "react";
import { AppState, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { confirm } from "@/components/ui/confirm";
import { authToken } from "@/data/api/auth-token";
import type { SupportLogState } from "@/data/api/endpoints/support-log";
import { qk } from "@/data/queryKeys";
import { effectsForFrame } from "@/data/realtime/event-map";
import { decodeHex, encodeBase64Url } from "@/lib/crypto/bytes";
import {
  clearDeviceIdentityAccount,
  deviceIdentity,
  setDeviceIdentityAccount,
} from "@/lib/crypto/identity";
import type { SignedSupportLogConsent } from "@/lib/crypto/support-log-consent";
import { secureStorage } from "@/lib/secure-storage";
import vectors from "../../../../../proto/support-log-consent-v1-vectors.json";
import { createTestQueryClient, renderWithProviders } from "../../../../tests/render";
import { AccountPanel } from "../account-panel";
import copy from "../support-log-copy.json";
import { SupportLogSettings } from "../support-log-settings";

const mockAccount = randomUUID();
const device = randomUUID();
const host = randomUUID();
const now = vectors.positive[0]?.consent.issued_at_ms ?? 0;
const stamp = now + 27;
const iso = new Date(now).toISOString();
const key = vectors.positive[0]?.consent.signer_public_key ?? "";
const seed = vectors.positive[0]?.signing_seed_hex ?? "";

jest.mock("@/data/api/config", () => ({ getBaseUrl: async () => "" }));
jest.mock("@/data/api/auth-token", () => ({
  authToken: {
    snapshot: async () => ({ token: null }),
    captureFromResponse: async () => null,
    clearIfCurrent: jest.fn(async () => true),
  },
}));
jest.mock("@/components/ui/confirm", () => ({
  ...jest.requireActual("@/components/ui/confirm"),
  confirm: jest.fn(async () => true),
}));
jest.mock("@/components/ui/toast", () => ({ useToast: () => ({}) }));
jest.mock("expo-notifications", () => ({}));
jest.mock("expo-router", () => ({ useRouter: () => ({ back: jest.fn() }) }));
jest.mock("@/data/queries/settings", () => ({
  useMeSettingsQuery: () => ({
    data: { user: { id: mockAccount, email: "", email_verified_at: "verified" } },
  }),
  useDeleteAccountMutation: () => ({}),
}));
jest.mock("@/data/queries/auth", () => ({ useSignOutEverywhereMutation: () => ({}) }));

function state(sharing: SupportLogState["sharing"] = "off"): SupportLogState {
  return {
    sharing,
    next_issued_at_ms: stamp,
    retention_days: 7,
    statement:
      sharing === "off"
        ? null
        : { enabled: true, issued_at_ms: now, signer_device_id: device, signer_device_name: null },
    hosts: [{ id: host, name: "This machine", capable: false, last_seen_at: null }],
    collections: [],
  };
}

function response(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
}

function fixture(initial = state()) {
  const local = {
    id: device,
    public_key: key,
    key_algorithm: "ed25519",
    revoked_at: null,
    created_at: iso,
    label: null,
  };
  const client = createTestQueryClient();
  client.setQueryData(qk.browserDeviceRegistration(mockAccount), local);
  const wire = {
    get: jest.fn<Promise<Response>, []>(async () => response(200, initial)),
    put: jest.fn<Promise<Response>, [SignedSupportLogConsent]>(async () =>
      response(200, state("on")),
    ),
    devices: [local],
    rosterStatus: 200,
    edges: [] as {
      endorser_device_id: string;
      endorsed_device_id: string;
      endorser_public_key: string;
      endorsed_public_key: string;
      signature: string;
      created_at: string;
    }[],
    pins: [device] as string[],
  };
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(async (path, init) => {
    switch (path) {
      case "/api/support-log":
        return wire.get();
      case "/api/support-log/consent":
        expect(init?.method).toBe("PUT");
        return wire.put(JSON.parse(String(init?.body)));
      case "/api/browser-devices":
        return response(wire.rosterStatus, wire.devices);
      case "/api/trust/account-endorsements":
        return response(200, wire.edges);
      case `/api/trust/hosts/${host}/pins`:
        return response(200, wire.pins);
      default:
        throw new Error("Unexpected request");
    }
  });
  const show = () =>
    renderWithProviders(<SupportLogSettings accountId={mockAccount} />, { queryClient: client });
  return { wire, fetch, show, client };
}

beforeEach(() => {
  jest.useFakeTimers({ now });
  jest.clearAllMocks();
  setDeviceIdentityAccount(mockAccount);
  jest.spyOn(secureStorage, "get").mockResolvedValue(
    JSON.stringify({
      version: 1,
      accountId: mockAccount,
      publicKey: key,
      secretKey: encodeBase64Url(decodeHex(seed)),
    }),
  );
  AppState.currentState = "active";
});
afterEach(() => {
  clearDeviceIdentityAccount();
  jest.restoreAllMocks();
});

async function tick(ms = 1) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

for (const failure of ["404", "401", "bad shape", "network", "201"]) {
  test(`${failure} adds only the Account discovery read and preserves its structure`, async () => {
    const { wire, fetch, client } = fixture();
    if (failure === "network") wire.get.mockRejectedValue(new Error());
    else
      wire.get.mockResolvedValue(
        response(
          failure === "bad shape" ? 200 : Number(failure),
          failure === "bad shape" ? { ...state(), collections: [{}] } : state(),
        ),
      );
    const account = (
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 400, height: 800 },
          insets: { top: 0, right: 0, left: 0, bottom: 0 },
        }}
      >
        <AccountPanel />
      </SafeAreaProvider>
    );
    const screen = await renderWithProviders(<View />, { queryClient: client });
    expect(fetch).not.toHaveBeenCalled();
    await screen.rerender(account);
    await tick(180_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(authToken.clearIfCurrent).not.toHaveBeenCalled();
    const panel = within(screen.getByTestId("account-panel"));
    expect(panel.queryByText(copy.title)).toBeNull();
    expect(
      panel.getAllByRole("button").map((b) => within(b).getAllByText(/.+/)[0]?.props["children"]),
    ).toEqual(["Log out", "Sign out everywhere", "Delete account…"]);
    expect(panel.getByText("Signed in as", { exact: false })).toBeOnTheScreen();
    expect(panel.getByTestId("delete-account-section")).toBeOnTheScreen();
    expect(panel.queryByRole("switch")).toBeNull();
  });
}

test("a refused approval lookup cannot clear the phone session", async () => {
  const { wire, show } = fixture();
  wire.rosterStatus = 401;
  const screen = await show();
  await tick();
  expect(screen.getByRole("switch")).toBeDisabled();
  expect(wire.put).not.toHaveBeenCalled();
  expect(authToken.clearIfCurrent).not.toHaveBeenCalled();
});

test("shows removed signer, host update and all collection outcomes in response order", async () => {
  const data = state("off_signer_removed");
  const base = {
    id: "",
    host_id: null,
    host_name: "This machine",
    requested_at: iso,
    completed_at: iso,
    size_bytes: 21,
    expires_at: iso,
    deleted_at: iso,
    reason: "",
  };
  const states = [
    "requested",
    "dispatched",
    "collected",
    "deleted",
    "cancelled",
    "failed",
    "expired",
  ] as const;
  const declines = [
    "not_consented",
    "signer_untrusted",
    "rate_limited",
    "no_log",
    "failed",
  ] as const;
  data.collections = [
    ...states.map((state) => ({ ...base, id: randomUUID(), reason: state, state })),
    ...declines.map((decline_code) => ({
      ...base,
      id: randomUUID(),
      reason: decline_code,
      state: "declined" as const,
      decline_code,
    })),
  ];
  const screen = await fixture(data).show();
  await tick();
  expect(screen.getByText(copy.offSignerRemoved)).toBeOnTheScreen();
  expect(screen.getByText(copy.needsUpdate.replace("{machine}", "This machine"))).toBeOnTheScreen();
  const templates = [
    copy.waiting,
    copy.waiting,
    copy.kept,
    copy.deleted,
    copy.notCollected,
    copy.notCollected,
    copy.notCollected,
    copy.sharingOff,
    copy.notAccepted,
    copy.notCollected,
    copy.notCollected,
    copy.notCollected,
  ];
  const expected = templates.map((text) =>
    text
      .replace("{time}", new Date(iso).toLocaleString())
      .replace("{date}", new Date(iso).toLocaleDateString())
      .replace("{size}", "21 B")
      .replace("{machine}", "This machine"),
  );
  expect(
    screen.getAllByText(/^(Requested|Collected) /).map((node) => node.props["children"]),
  ).toEqual(expected);
  expect(screen.getAllByText(/^Reason:/).map((node) => node.props["children"])).toEqual(
    data.collections.map((row) => copy.reason.replace("{reason}", row.reason)),
  );
});

test("one confirmed on and immediate off use the server's state and signing time", async () => {
  const { wire, show } = fixture();
  const approvers = Array.from({ length: 66 }, () => ({
    id: randomUUID(),
    public_key: generateKeyPairSync("ed25519")
      .publicKey.export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64url"),
    key_algorithm: "ed25519",
    revoked_at: null,
    created_at: iso,
    label: null,
  }));
  wire.devices.push(...approvers);
  wire.pins = approvers.slice(1).map((d) => d.id);
  wire.edges = approvers.map((d) => ({
    endorser_device_id: d.id,
    endorsed_device_id: device,
    endorser_public_key: d.public_key,
    endorsed_public_key: key,
    signature: "A".repeat(86),
    created_at: iso,
  }));
  wire.get.mockResolvedValue(response(200, { ...state(), account_id: randomUUID() }));
  let finish!: (reply: Response) => void;
  wire.put.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const screen = await show();
  const toggle = () => screen.getByRole("switch", { name: copy.switchLabel });
  await waitFor(() => expect(toggle()).toBeEnabled());
  expect(screen.getByText(copy.empty)).toBeOnTheScreen();
  jest.mocked(confirm).mockResolvedValueOnce(false);
  await fireEvent.press(toggle());
  expect(wire.put).not.toHaveBeenCalled();
  const sign = jest.spyOn(deviceIdentity, "signSupportLogConsent");
  await fireEvent.press(toggle());
  await waitFor(() => expect(wire.put).toHaveBeenCalledTimes(1));
  expect(confirm).toHaveBeenCalledWith({
    title: copy.confirmTitle,
    description: copy.description,
    confirmLabel: copy.turnOn,
    cancelLabel: copy.cancel,
  });
  await fireEvent.press(toggle());
  await waitFor(() => expect(toggle()).toBeDisabled());
  expect(sign).toHaveBeenCalledTimes(1);
  expect(wire.put.mock.calls[0]?.[0]).toMatchObject({
    version: 1,
    enabled: true,
    account_id: mockAccount,
    signer_device_id: device,
    signer_public_key: key,
    issued_at_ms: stamp,
    carried_endorsements: approvers.slice(1, 65).map((d) => ({
      account_id: mockAccount,
      endorser_public_key: d.public_key,
      endorsed_public_key: key,
      endorsed_device_id: device,
      signature: "A".repeat(86),
    })),
  });
  finish(response(200, { ...state("on"), next_issued_at_ms: stamp + 1 }));
  await waitFor(() => expect(toggle()).toBeChecked());
  expect(screen.getByText(copy.sent)).toBeOnTheScreen();
  wire.put.mockResolvedValueOnce(response(200, state("off_signer_removed")));
  await waitFor(() => expect(toggle()).toBeEnabled());
  await fireEvent.press(toggle());
  await waitFor(() => expect(screen.getByText(copy.offSignerRemoved)).toBeOnTheScreen());
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(wire.put).toHaveBeenCalledTimes(2);
  expect(wire.put.mock.calls[1]?.[0]).toMatchObject({ enabled: false, issued_at_ms: stamp + 1 });
  expect(wire.get).toHaveBeenCalledTimes(1);
});

test.each([
  [403, copy.removed],
  [409, copy.stale],
  [429, copy.wait.replace("{seconds}", "19")],
  [500, copy.failure],
] as const)("%i shows its refusal and stale reads only once", async (status, message) => {
  const { wire, show } = fixture(state("on"));
  wire.put.mockResolvedValue(response(status, { detail: { retry_after_seconds: 19 } }));
  const screen = await show();
  const toggle = () => screen.getByRole("switch", { name: copy.switchLabel });
  await waitFor(() => expect(toggle()).toBeEnabled());
  await fireEvent.press(toggle());
  await waitFor(() => expect(screen.getByText(message)).toBeOnTheScreen());
  expect(toggle()).toBeChecked();
  expect(wire.get).toHaveBeenCalledTimes(status === 409 ? 2 : 1);
  expect(wire.put).toHaveBeenCalledTimes(1);
});

test.each([
  now - 86_400_001,
  now + 90_000_000,
  Number.MAX_SAFE_INTEGER + 1,
  { code: "future_timestamp" as const },
])("an unusable signing time refuses before signing", async (time) => {
  const { wire, show } = fixture({ ...state("on"), next_issued_at_ms: time });
  const sign = jest.spyOn(deviceIdentity, "signSupportLogConsent");
  const screen = await show();
  await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
  await fireEvent.press(screen.getByRole("switch"));
  await waitFor(() => expect(screen.getByText(copy.failure)).toBeOnTheScreen());
  expect(sign).not.toHaveBeenCalled();
  expect(wire.put).not.toHaveBeenCalled();
});

test.each(["no key", "no approval"])("a phone with %s cannot sign", async (why) => {
  const { wire, show } = fixture();
  if (why === "no key") jest.mocked(secureStorage.get).mockResolvedValue(null);
  else wire.pins = [];
  const screen = await show();
  await tick();
  expect(screen.getByText(copy.cannotSign)).toBeOnTheScreen();
  expect(screen.getByRole("switch")).toBeDisabled();
  await fireEvent.press(screen.getByRole("switch"));
  expect(wire.put).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
});

test("focus, panel show and data events refresh while visible with no polling", async () => {
  let notify = () => {};
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
    notify = () => listener(AppState.currentState);
    return { remove: jest.fn() };
  });
  let focused = true;
  const listeners = new Map<string, () => void>();
  const navigation = {
    isFocused: () => focused,
    addListener: (event: string, fn: () => void) => {
      listeners.set(event, fn);
      return () => listeners.delete(event);
    },
  } as unknown as ContextType<typeof NavigationContext>;
  const { wire, client } = fixture();
  await renderWithProviders(
    <NavigationContext.Provider value={navigation}>
      <SupportLogSettings accountId={mockAccount} />
    </NavigationContext.Provider>,
    { queryClient: client },
  );
  await tick(180_000);
  expect(wire.get).toHaveBeenCalledTimes(1);
  const event = async () => {
    for (const effect of effectsForFrame({
      type: "data",
      resource: "support-log",
      id: null,
      origin: null,
      at: iso,
    })) {
      if (effect.kind === "invalidate") await client.invalidateQueries({ queryKey: effect.key });
    }
  };
  await act(event);
  expect(wire.get).toHaveBeenCalledTimes(2);
  await act(() => {
    AppState.currentState = "background";
    notify();
  });
  await act(event);
  await tick(180_000);
  expect(wire.get).toHaveBeenCalledTimes(2);
  await act(() => {
    AppState.currentState = "active";
    notify();
  });
  await tick();
  expect(wire.get).toHaveBeenCalledTimes(3);
  await act(() => {
    focused = false;
    listeners.get("blur")?.();
  });
  await act(event);
  await tick(180_000);
  expect(wire.get).toHaveBeenCalledTimes(3);
  await act(() => {
    focused = true;
    listeners.get("focus")?.();
  });
  await tick();
  expect(wire.get).toHaveBeenCalledTimes(4);
});
