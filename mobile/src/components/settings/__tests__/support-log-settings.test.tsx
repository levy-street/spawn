import { randomBytes, randomUUID } from "node:crypto";
import { NavigationContext } from "@react-navigation/native";
import { act, fireEvent, waitFor, within } from "@testing-library/react-native";
import type { ContextType } from "react";
import { AppState, Platform, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { confirm } from "@/components/ui/confirm";
import { authToken } from "@/data/api/auth-token";
import type { SupportLogState } from "@/data/api/endpoints/support-log";
import * as supportApi from "@/data/api/endpoints/support-log";
import type { AccountEndorsementRecord } from "@/data/api/schemas/trust";
import { qk } from "@/data/queryKeys";
import { effectsForFrame } from "@/data/realtime/event-map";
import { decodeHex, encodeBase64Url } from "@/lib/crypto/bytes";
import * as ed25519 from "@/lib/crypto/ed25519";
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
let stamp = now + 27;
const iso = new Date(now).toISOString();
const key = vectors.positive[0]?.consent.signer_public_key ?? "";
const seed = vectors.positive[0]?.signing_seed_hex ?? "";

jest.mock("@/data/api/config", () => ({ getBaseUrl: async () => "" }));
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
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => body,
  } as Response;
}

const self = { id: device, publicKey: key };
function peer() {
  return { id: randomUUID(), publicKey: randomBytes(32).toString("base64url") };
}

function approval(from: typeof self, to: typeof self): AccountEndorsementRecord {
  return {
    endorser_device_id: from.id,
    endorsed_device_id: to.id,
    endorser_public_key: from.publicKey,
    endorsed_public_key: to.publicKey,
    signature: "A".repeat(86),
    created_at: iso,
  };
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
  client.setQueryData(qk.me(), { user: { id: mockAccount } });
  const wire = {
    get: jest.fn<Promise<Response>, []>(async () => response(200, initial)),
    put: jest.fn<Promise<Response>, [SignedSupportLogConsent]>(async () =>
      response(200, state("on")),
    ),
    approvalStatus: 200,
    edges: [] as AccountEndorsementRecord[],
  };
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(async (path, init) => {
    switch (path) {
      case "/api/support-log":
        return wire.get();
      case "/api/support-log/consent":
        expect(init?.method).toBe("PUT");
        return wire.put(JSON.parse(String(init?.body)));
      case "/api/trust/account-endorsements":
        return response(wire.approvalStatus, wire.edges);
      default:
        throw new Error("Unexpected request");
    }
  });
  const show = () =>
    renderWithProviders(<SupportLogSettings accountId={mockAccount} />, { queryClient: client });
  return { wire, fetch, show, client, local };
}

const storage = new Map<string, string>();
beforeEach(async () => {
  stamp += 10;
  storage.clear();
  jest.useFakeTimers({ now });
  jest.clearAllMocks();
  setDeviceIdentityAccount(mockAccount);
  jest.spyOn(secureStorage, "get").mockImplementation(async (k) => storage.get(k) ?? null);
  jest.spyOn(secureStorage, "set").mockImplementation(async (k, v) => {
    storage.set(k, v);
  });
  jest.spyOn(secureStorage, "delete").mockImplementation(async (k) => {
    storage.delete(k);
  });
  storage.set(
    `spawn.identity.ed25519.v1.${mockAccount}`,
    JSON.stringify({
      version: 1,
      accountId: mockAccount,
      publicKey: key,
      secretKey: encodeBase64Url(decodeHex(seed)),
    }),
  );
  await authToken.set(randomUUID());
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

function accountPanel() {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 400, height: 800 },
        insets: { top: 0, right: 0, left: 0, bottom: 0 },
      }}
    >
      <AccountPanel />
    </SafeAreaProvider>
  );
}

for (const [failure, status, body] of [
  ["404", 404, state()],
  ["401", 401, state()],
  ["bad shape", 200, { ...state(), collections: [{}] }],
  ["network", 0, null],
  ["201", 201, state()],
  ["on without a statement", 200, { ...state(), sharing: "on" }],
  ["removed without a statement", 200, { ...state(), sharing: "off_signer_removed" }],
  ["off with an enabled statement", 200, { ...state("on"), sharing: "off" }],
  ...(["on", "off_signer_removed"] as const).map(
    (sharing) =>
      [
        `${sharing} with a disabled statement`,
        200,
        { ...state(sharing), statement: { ...state(sharing).statement, enabled: false } },
      ] as const,
  ),
  ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(
    (time) =>
      [
        `invalid stored time ${time}`,
        200,
        { ...state("on"), statement: { ...state("on").statement, issued_at_ms: time } },
      ] as const,
  ),
] as const) {
  test(`${failure} adds only the Account discovery read and preserves its structure`, async () => {
    const { wire, fetch, client } = fixture();
    if (status === 0) wire.get.mockRejectedValue(new Error());
    else wire.get.mockResolvedValue(response(status, body));
    const screen = await renderWithProviders(<View />, { queryClient: client });
    expect(fetch).not.toHaveBeenCalled();
    await screen.rerender(accountPanel());
    await tick(180_000);
    expect(fetch).toHaveBeenCalledTimes(1);

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
  expect(screen.queryByText(copy.help)).toBeNull();
  const templates = [
    copy.waiting,
    copy.waiting,
    copy.kept,
    copy.deleted,
    copy.notCollected,
    copy.notCollected,
    copy.notCollected,
    copy.sharingOff,
    `${copy.notAccepted} ${copy.signerHelp}`,
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
  const { wire, show, fetch, client, local } = fixture();
  const refreshRegistration = (time: number) =>
    act(() => {
      client.setQueryData(qk.browserDeviceRegistration(mockAccount), {
        ...local,
        last_seen_at: new Date(time).toISOString(),
      });
    });
  const peers = Array.from({ length: 9 }, peer);
  const path = peers.map((from, i) => approval(from, peers[i - 1] ?? self));
  const branch = approval(peer(), self);
  wire.edges = [approval(peer(), peer()), ...[...path].reverse(), branch];
  const nearest = [...path.slice(0, 1), branch, ...path.slice(1, 8)];
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
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.getByText(copy.empty)).toBeOnTheScreen();
  jest.mocked(confirm).mockResolvedValueOnce(false);
  await fireEvent.press(toggle());
  expect(wire.put).not.toHaveBeenCalled();
  expect(screen.getByText(copy.help)).toBeOnTheScreen();
  let answer!: (yes: boolean) => void;
  jest.mocked(confirm).mockReturnValueOnce(
    new Promise((resolve) => {
      answer = resolve;
    }),
  );
  const sign = jest.spyOn(deviceIdentity, "signSupportLogConsent");
  await fireEvent.press(toggle());
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
  await refreshRegistration(now + 1);
  await act(() => answer(true));
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
    carried_endorsements: nearest.map(
      ({ endorser_public_key, endorsed_public_key, endorsed_device_id, signature }) => ({
        account_id: mockAccount,
        endorser_public_key,
        endorsed_public_key,
        endorsed_device_id,
        signature,
      }),
    ),
  });
  wire.get.mockResolvedValue(response(200, { ...state("on"), next_issued_at_ms: stamp + 1 }));
  await refreshRegistration(now + 2);
  finish(response(200, state())); // A delayed PUT body must not replace the GET.
  await waitFor(() => expect(toggle()).toBeChecked());
  expect(screen.getByText(copy.sent)).toBeOnTheScreen();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/api/support-log",
    "/api/trust/account-endorsements",
    "/api/support-log",
    "/api/support-log/consent",
    "/api/support-log",
  ]);
  wire.put.mockImplementationOnce(async () => {
    wire.get.mockResolvedValue(response(200, state("off_signer_removed")));
    return response(200, state("on"));
  });
  await waitFor(() => expect(toggle()).toBeEnabled());
  await fireEvent.press(toggle());
  await waitFor(() => expect(screen.getByText(copy.offSignerRemoved)).toBeOnTheScreen());
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(wire.put).toHaveBeenCalledTimes(2);
  expect(wire.put.mock.calls[1]?.[0]).toMatchObject({ enabled: false, issued_at_ms: stamp + 1 });
  expect(wire.get).toHaveBeenCalledTimes(5);
});

test.each([
  [403, copy.removed],
  [409, copy.stale],
  [429, copy.wait.replace("{seconds}", "19")],
  [500, copy.failure],
] as const)("%i shows its refusal and stale reads only once", async (status, message) => {
  const { wire, show } = fixture(state("on"));
  wire.put.mockImplementation(async () => {
    if (status === 429) wire.get.mockRejectedValue(new Error());
    return response(status, { detail: { retry_after_seconds: 19 } });
  });
  const screen = await show();
  const toggle = () => screen.getByRole("switch", { name: copy.switchLabel });
  await waitFor(() => expect(toggle()).toBeEnabled());
  await fireEvent.press(toggle());
  await waitFor(() => expect(screen.getByText(message)).toBeOnTheScreen());
  await waitFor(() => expect(toggle()).toBeEnabled());
  expect(screen.getByText(message)).toBeOnTheScreen();
  expect(toggle()).toBeChecked();
  expect(wire.get).toHaveBeenCalledTimes(3);
  expect(wire.put).toHaveBeenCalledTimes(1);
});

test.each([
  now,
  now - 1,
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

test("discovery waits quietly for registration to return the local key", async () => {
  const { client, show, local } = fixture();
  const queryKey = qk.browserDeviceRegistration(mockAccount);
  client.removeQueries({ queryKey });
  let fail!: () => void;
  const pending = client
    .fetchQuery({
      queryKey,
      retry: false,
      queryFn: () =>
        new Promise((_, reject) => {
          fail = () => reject(new Error());
        }),
    })
    .catch(() => {});
  const screen = await show();
  await waitFor(() => expect(screen.getByRole("switch")).toBeDisabled());
  expect(screen.queryByText(copy.cannotSign)).toBeNull();
  await act(async () => {
    fail();
    await pending;
  });
  expect(screen.getByRole("switch")).toBeDisabled();
  expect(screen.queryByText(copy.cannotSign)).toBeNull();
  await act(() => {
    client.setQueryData(queryKey, local);
  });
  await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
  expect(screen.queryByText(copy.cannotSign)).toBeNull();
});

test("a phone without a local key cannot send a change", async () => {
  const { wire, show, fetch } = fixture();
  storage.delete(`spawn.identity.ed25519.v1.${mockAccount}`);
  const sign = jest.spyOn(deviceIdentity, "signSupportLogConsent");
  const screen = await show();
  await waitFor(() => expect(screen.getByText(copy.cannotSign)).toBeOnTheScreen());
  expect(screen.getByRole("switch")).toBeDisabled();
  await fireEvent.press(screen.getByRole("switch"));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sign).not.toHaveBeenCalled();
  expect(wire.put).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
});

test("a delayed signing read cannot go behind a newer stored statement", async () => {
  const { wire, show, client } = fixture(state("on"));
  const screen = await show();
  await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
  let finish!: (reply: Response) => void;
  wire.get.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const sign = jest.spyOn(deviceIdentity, "signSupportLogConsent");
  await fireEvent.press(screen.getByRole("switch"));
  await waitFor(() => expect(wire.get).toHaveBeenCalledTimes(2));
  const newer = state("off_signer_removed");
  if (newer.statement) newer.statement.issued_at_ms = stamp + 1;
  wire.get.mockResolvedValue(response(200, newer));
  await act(() => client.invalidateQueries({ queryKey: qk.supportLog() }));
  await waitFor(() => expect(screen.getByText(copy.offSignerRemoved)).toBeOnTheScreen());
  await act(() => finish(response(200, state("on"))));
  await waitFor(() => expect(screen.getByText(copy.failure)).toBeOnTheScreen());
  expect(sign).not.toHaveBeenCalled();
  expect(wire.put).not.toHaveBeenCalled();
});

test("focus, panel show and data events refresh while visible with no polling", async () => {
  jest.replaceProperty(Platform, "OS", "android");
  let windowFocus = () => {};
  let notify = () => {};
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
    if (_type === "focus") windowFocus = () => listener(AppState.currentState);
    if (_type === "change") notify = () => listener(AppState.currentState);
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
  await act(windowFocus);
  await tick();
  expect(wire.get).toHaveBeenCalledTimes(5);
});

test("a refresh during confirmation and a replay after reopening", async () => {
  const { wire, show, client } = fixture();
  client.setQueryData(qk.trustAccountEndorsements(), wire.edges);
  let answer!: (yes: boolean) => void;
  jest.mocked(confirm).mockReturnValueOnce(
    new Promise((resolve) => {
      answer = resolve;
    }),
  );
  const crypto = jest.spyOn(ed25519, "signPureEd25519");
  const signatures = () => crypto.mock.calls.filter(([, message]) => message.length === 102);
  const screen = await show();
  await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
  await fireEvent.press(screen.getByRole("switch"));
  wire.get.mockResolvedValue(response(200, { ...state(), next_issued_at_ms: stamp + 1 }));
  await act(() => client.invalidateQueries({ queryKey: qk.supportLog() }));
  wire.get.mockResolvedValue(response(200, { ...state(), next_issued_at_ms: stamp + 2 }));
  await act(() => answer(true));
  await waitFor(() => expect(screen.getByText(copy.sent)).toBeOnTheScreen());
  expect(wire.put.mock.calls[0]?.[0].issued_at_ms).toBe(stamp + 2);
  expect(signatures()).toHaveLength(1);
  await screen.unmount();
  const reopened = await show();
  await waitFor(() => expect(reopened.getByRole("switch")).toBeEnabled());
  await fireEvent.press(reopened.getByRole("switch"));
  await waitFor(() => expect(reopened.getByText(copy.failure)).toBeOnTheScreen());
  expect(wire.put).toHaveBeenCalledTimes(1);
  expect(signatures()).toHaveLength(1);
});

test.each([200, 409])("a late %i cannot overwrite another device's withdrawal", async (status) => {
  const { wire, client, show, fetch } = fixture();
  client.setQueryData(qk.trustAccountEndorsements(), wire.edges);
  let finish!: (reply: Response) => void;
  wire.put.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const screen = await show();
  await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
  expect(fetch).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByRole("switch"));
  await waitFor(() => expect(wire.put).toHaveBeenCalledTimes(1));
  wire.get.mockResolvedValue(response(200, state("off_signer_removed")));
  await act(() => client.invalidateQueries({ queryKey: qk.supportLog() }));
  await waitFor(() => expect(screen.getByText(copy.offSignerRemoved)).toBeOnTheScreen());
  await act(() => finish(response(status, state("on"))));
  await waitFor(() =>
    expect(screen.getByText(status === 409 ? copy.stale : copy.sent)).toBeOnTheScreen(),
  );
  expect(screen.getByRole("switch")).not.toBeChecked();
  expect(wire.get).toHaveBeenCalledTimes(4);
  expect(fetch).toHaveBeenCalledTimes(5);
});

test("closing Account ignores a late approval before signing", async () => {
  const { fetch, show, wire } = fixture(state("on"));
  const impl = fetch.getMockImplementation();
  if (!impl) throw new Error("Missing test transport");
  const sign = jest.spyOn(deviceIdentity, "signSupportLogConsent");
  let settle!: (r: Response) => void;
  fetch.mockImplementation((input, init) => {
    if (input !== "/api/trust/account-endorsements") return impl(input, init);
    return new Promise((resolve) => {
      settle = resolve;
    });
  });
  const screen = await show();
  await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
  expect(fetch).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByRole("switch"));
  await waitFor(() => expect(settle).toBeDefined());
  await screen.unmount();
  await act(() => settle(response(200, wire.edges)));
  expect(sign).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(wire.put).not.toHaveBeenCalled();
});

test("closing Account during the signer's key read produces no consent signature or PUT", async () => {
  const { wire, show } = fixture(state("on"));
  const crypto = jest.spyOn(ed25519, "signPureEd25519");
  const screen = await show();
  await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
  let finish!: () => void;
  wire.get.mockImplementationOnce(async () => {
    jest.mocked(secureStorage.get).mockImplementationOnce(
      (k) =>
        new Promise((resolve) => {
          finish = () => resolve(storage.get(k) ?? null);
        }),
    );
    return response(200, state("on"));
  });
  await fireEvent.press(screen.getByRole("switch"));
  await waitFor(() => expect(finish).toBeDefined());
  await screen.unmount();
  await act(() => finish());
  expect(crypto.mock.calls.filter(([, bytes]) => bytes.length === 102)).toHaveLength(0);
  expect(wire.put).not.toHaveBeenCalled();
});

test("a throwing log row leaves the account deletion form usable", async () => {
  const data = state();
  data.collections = [
    {
      id: randomUUID(),
      host_id: null,
      host_name: "",
      reason: "",
      requested_at: iso,
      completed_at: null,
      size_bytes: null,
      expires_at: null,
      deleted_at: null,
      state: "requested",
    },
  ];
  const { client, wire } = fixture(data);
  jest.spyOn(supportApi, "collectionLine").mockImplementation(() => {
    throw new Error("Broken row");
  });
  jest.spyOn(console, "error").mockImplementation(() => {});
  const screen = await renderWithProviders(accountPanel(), { queryClient: client });
  await tick();
  expect(wire.get).toHaveBeenCalledTimes(1);
  expect(supportApi.collectionLine).toHaveBeenCalled();
  expect(screen.queryByText(copy.title)).toBeNull();
  await fireEvent.press(screen.getByText("Delete account…"));
  expect(screen.getByText("Type your email to confirm")).toBeOnTheScreen();
});

test.each([false, true])(
  "a change carries at most 64 nearest approvals or none on read failure (%s)",
  async (failedRead) => {
    const { wire, show } = fixture(state("on"));
    const first = peer();
    const peers = [first, ...Array.from({ length: 64 }, peer)];
    const nearest = peers.map((p) => approval(p, self));
    wire.edges = [approval(peer(), first), ...nearest];
    if (failedRead) wire.approvalStatus = 503;
    wire.put.mockImplementation(async () => {
      wire.get.mockRejectedValue(new Error());
      return response(204, null);
    });
    const screen = await show();
    await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
    await fireEvent.press(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByText(copy.sent)).toBeOnTheScreen());
    await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
    expect(screen.getByRole("switch")).toBeChecked();
    expect(
      wire.put.mock.calls[0]?.[0].carried_endorsements.map((e) => e.endorser_public_key),
    ).toEqual(failedRead ? [] : nearest.slice(0, 64).map((e) => e.endorser_public_key));
  },
);
