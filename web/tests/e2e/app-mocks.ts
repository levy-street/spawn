import { createHash } from "node:crypto";
import type { Page, Route } from "@playwright/test";

export const USER_ID = "00000000-0000-4000-8000-000000000001";
export const HOST_ID = "00000000-0000-4000-8000-000000000002";
export const PRESET_ID = "00000000-0000-4000-8000-000000000003";
export const AGENT_ID = "00000000-0000-4000-8000-000000000004";
export const SKILL_ID = "00000000-0000-4000-8000-000000000006";
export const SCREEN_ID = "00000000-0000-4000-8000-000000000007";
export const AGENT_B_ID = "00000000-0000-4000-8000-000000000008";
export const BROWSER_DEVICE_ID = "00000000-0000-4000-8000-000000000009";
export const CREATED_AT = "2026-05-24T00:00:00Z";

export const user = {
  id: USER_ID,
  email: "tester@example.com",
  created_at: CREATED_AT,
};

export const host = {
  id: HOST_ID,
  name: "Mac",
  os: "macos",
  arch: "aarch64",
  version: "0.1.0",
  status: "online",
  last_seen_at: CREATED_AT,
  agent_count: 1,
  home_dir: "/Users/tester",
};

export const preset = {
  id: PRESET_ID,
  owner_user_id: null,
  name: "codex",
  agent_kind: "codex",
  default_argv: ["codex"],
  env_template: {},
  install: "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
};

export function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    name: "palette",
    host_id: HOST_ID,
    host_name: "Mac",
    preset_id: PRESET_ID,
    cwd: "/Users/tester/projects/spawn",
    argv: ["codex"],
    env: {},
    status: "running",
    started_at: CREATED_AT,
    exited_at: null,
    last_output_at: CREATED_AT,
    last_input_at: null,
    last_activity_at: CREATED_AT,
    activity_state: "quiet",
    activity_label: "Quiet",
    exit_code: null,
    pinned_at: null,
    archived_at: null,
    ...overrides,
  };
}

export function skill(overrides: Record<string, unknown> = {}) {
  return {
    id: SKILL_ID,
    owner_user_id: USER_ID,
    name: "review skill",
    description: "Review local changes",
    content: "Use /review on the current diff.",
    enabled_by_default: false,
    created_at: CREATED_AT,
    ...overrides,
  };
}

export function screen(overrides: Record<string, unknown> = {}) {
  return {
    id: SCREEN_ID,
    name: "daily drive",
    layout: {
      root: {
        type: "split",
        direction: "row",
        ratio: 0.5,
        a: { type: "pane", agent_id: AGENT_ID },
        b: { type: "pane", agent_id: AGENT_B_ID },
      },
    },
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

export function fileEntry(overrides: Record<string, unknown> = {}) {
  return {
    name: "notes.txt",
    path: "/Users/tester/notes.txt",
    is_dir: false,
    size: 2048,
    modified_at: 1750000000,
    ...overrides,
  };
}

export function fileListing(overrides: Record<string, unknown> = {}) {
  return {
    path: "/Users/tester",
    home_dir: "/Users/tester",
    parent: "/Users",
    entries: [
      fileEntry({ name: "projects", path: "/Users/tester/projects", is_dir: true, size: null }),
      fileEntry(),
    ],
    error: null,
    ...overrides,
  };
}

export async function mockAuthenticatedApi(
  page: Page,
  options: {
    agents?: unknown[];
    hosts?: unknown[];
    screens?: unknown[];
    updateScreen?: (id: string, body: unknown, route: Route) => Promise<void> | void;
    createScreen?: (body: unknown, route: Route) => Promise<void> | void;
    restartAgent?: (id: string, route: Route) => Promise<void> | void;
    skills?: unknown[];
    createAgent?: (body: unknown, route: Route) => Promise<void> | void;
    updateAgent?: (id: string, body: unknown, route: Route) => Promise<void> | void;
    createSkill?: (body: unknown, route: Route) => Promise<void> | void;
    updateSkill?: (id: string, body: unknown, route: Route) => Promise<void> | void;
    deleteSkill?: (id: string, route: Route) => Promise<void> | void;
    files?: (hostId: string, path: string | null) => unknown;
    fileRead?: (hostId: string, path: string) => string | Uint8Array;
    fileUpload?: (hostId: string, route: Route) => Promise<void> | void;
    fileMkdir?: (hostId: string, body: unknown, route: Route) => Promise<void> | void;
    fileDelete?: (hostId: string, body: unknown, route: Route) => Promise<void> | void;
    fileRename?: (hostId: string, body: unknown, route: Route) => Promise<void> | void;
    /** Pre-registered devices beyond the one this browser registers itself. */
    extraBrowserDevices?: Array<Record<string, unknown>>;
    /** hostId → browser device ids the host trusts; endorsements append here. */
    hostPins?: Record<string, string[]>;
    /** endorsed device id → endorsement records served to that device. */
    endorsementsFor?: Record<string, Array<Record<string, unknown>>>;
    /** Seeded add-device pairing relay rows (served by GET, mutated by the
     * introductions endpoint). Shape: DevicePairingState JSON. */
    pairings?: Array<Record<string, unknown>>;
    /** Seeded durable host-introduction rows (continuous gossip store). */
    hostIntroductions?: Array<Record<string, unknown>>;
    /** Override the signed-in account (e.g. to grant is_admin). */
    me?: Record<string, unknown>;
  } = {},
) {
  const agents = options.agents ?? [];
  const hostList = options.hosts ?? [host];
  const screenList = options.screens ?? [];
  const skillList = options.skills ?? [];
  const browserDeviceList: Array<Record<string, unknown>> = [
    ...(options.extraBrowserDevices ?? []),
  ];
  const hostPinMap: Record<string, string[]> = { ...(options.hostPins ?? {}) };
  const pairingRows: Array<Record<string, unknown>> = [...(options.pairings ?? [])];
  const hostIntroductionRows: Array<Record<string, string>> = [
    ...((options.hostIntroductions ?? []) as Array<Record<string, string>>),
  ];

  const invokeFileHandler = async (
    handler: ((hostId: string, body: unknown, route: Route) => Promise<void> | void) | undefined,
    hostId: string,
    body: Record<string, unknown>,
    fallback: Record<string, unknown>,
  ) => {
    if (!handler) return fallback;
    let result: Record<string, unknown> | undefined;
    const route = {
      request: () => ({
        postData: () => `name="dir"\r\n\r\n${String(body.dir ?? "")}\r\n`,
        postDataJSON: async () => body,
      }),
      fulfill: async (response: { json?: Record<string, unknown> }) => {
        result = response.json;
      },
    } as unknown as Route;
    await handler(hostId, body, route);
    return result ?? fallback;
  };

  await page.exposeFunction(
    "__spawnHostControlRequest",
    async (hostId: string, operation: string, payload: Record<string, unknown>) => {
      const selected = (hostList as Array<{ id?: string; home_dir?: string }>).find(
        (item) => item.id === hostId,
      );
      const homeDir = selected?.home_dir ?? "/Users/tester";
      if (operation === "fs.home") return { home_dir: homeDir };
      if (operation === "fs.list") {
        return (
          options.files?.(hostId, String(payload.path ?? "~")) ?? fileListing({ path: homeDir })
        );
      }
      if (operation === "fs.mkdir") {
        return invokeFileHandler(
          options.fileMkdir,
          hostId,
          { path: payload.path },
          { path: payload.path },
        );
      }
      if (operation === "fs.rename") {
        return invokeFileHandler(
          options.fileRename,
          hostId,
          { path: payload.path, name: payload.name, overwrite: payload.overwrite ?? false },
          { path: payload.path },
        );
      }
      if (operation === "fs.remove") {
        return invokeFileHandler(
          options.fileDelete,
          hostId,
          { path: payload.path, recursive: payload.recursive ?? false },
          { path: payload.path },
        );
      }
      if (operation === "fs.read") {
        const bytes = Buffer.from(options.fileRead?.(hostId, String(payload.path)) ?? "hi");
        return {
          path: payload.path,
          name:
            String(payload.path ?? "file")
              .split("/")
              .at(-1) ?? "file",
          length: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes_b64: bytes.toString("base64"),
        };
      }
      if (operation === "fs.write.commit") {
        if (options.fileUpload) {
          let result: Record<string, unknown> | undefined;
          const route = {
            request: () => ({
              postData: () => `name="dir"\r\n\r\n${String(payload.dir ?? "")}\r\n`,
            }),
            fulfill: async (response: { json?: Record<string, unknown> }) => {
              result = response.json;
            },
          } as unknown as Route;
          await options.fileUpload(hostId, route);
          return result ?? { path: `${String(payload.dir)}/${String(payload.name)}` };
        }
        return { path: `${String(payload.dir)}/${String(payload.name)}` };
      }
      throw new Error(`unsupported mock host control operation: ${operation}`);
    },
  );

  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "showSaveFilePicker", {
      configurable: true,
      value: undefined,
    });

    type HostInvoke = (
      hostId: string,
      operation: string,
      payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    const invoke = () =>
      (
        globalThis as typeof globalThis & {
          __spawnHostControlRequest: HostInvoke;
        }
      ).__spawnHostControlRequest;

    class MockHostDataChannel {
      readonly label = "spawn.host.ctl";
      readonly bufferedAmount = 0;
      readyState: RTCDataChannelState = "connecting";
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      private readonly writes = new Map<
        string,
        { declaration: Record<string, unknown>; chunks: string[] }
      >();

      constructor(private readonly hostId: string) {}

      open() {
        this.readyState = "open";
        this.onopen?.(new Event("open"));
        this.emit({
          version: 1,
          type: "hello",
          protocol: "spawn.host.ctl",
          capabilities: [
            "ping",
            "fs.home",
            "fs.list",
            "fs.stat",
            "fs.read",
            "fs.write.begin",
            "fs.mkdir",
            "fs.rename",
            "fs.remove",
          ],
        });
      }

      close() {
        if (this.readyState === "closed") return;
        this.readyState = "closed";
        this.onclose?.(new Event("close"));
      }

      send(encoded: string) {
        const frame = JSON.parse(encoded) as Record<string, unknown>;
        void this.handle(frame);
      }

      private emit(frame: Record<string, unknown>) {
        setTimeout(
          () => this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) })),
          0,
        );
      }

      private async handle(frame: Record<string, unknown>) {
        const type = frame.type;
        if (type === "request") {
          const requestId = String(frame.request_id);
          const operation = String(frame.operation);
          const payload = (frame.payload ?? {}) as Record<string, unknown>;
          if (operation === "ping") {
            this.emit({
              version: 1,
              type: "response",
              request_id: requestId,
              ok: true,
              result: { pong: true },
            });
            return;
          }
          if (operation === "fs.write.begin") {
            const streamId = crypto.randomUUID();
            this.writes.set(streamId, { declaration: payload, chunks: [] });
            this.emit({
              version: 1,
              type: "response",
              request_id: requestId,
              ok: true,
              result: { stream_id: streamId },
            });
            return;
          }
          try {
            const result = await invoke()(this.hostId, operation, payload);
            if (operation === "fs.read") {
              const streamId = crypto.randomUUID();
              const bytes = String(result.bytes_b64 ?? "");
              const { bytes_b64: _, ...declaration } = result;
              this.emit({
                version: 1,
                type: "response",
                request_id: requestId,
                ok: true,
                result: { ...declaration, stream_id: streamId },
              });
              if (bytes)
                this.emit({
                  version: 1,
                  type: "stream.chunk",
                  stream_id: streamId,
                  sequence: 0,
                  bytes_b64: bytes,
                });
              this.emit({
                version: 1,
                type: "stream.end",
                stream_id: streamId,
                length: result.length,
                sha256: result.sha256,
              });
              return;
            }
            this.emit({ version: 1, type: "response", request_id: requestId, ok: true, result });
          } catch (error) {
            this.emit({
              version: 1,
              type: "response",
              request_id: requestId,
              ok: false,
              error: { code: "mock_failed", detail: String(error) },
            });
          }
          return;
        }
        const streamId = String(frame.stream_id ?? "");
        if (type === "stream.chunk") {
          this.writes.get(streamId)?.chunks.push(String(frame.bytes_b64 ?? ""));
          return;
        }
        if (type === "stream.cancel") {
          this.writes.delete(streamId);
          return;
        }
        if (type === "stream.end") {
          const write = this.writes.get(streamId);
          if (!write) return;
          this.writes.delete(streamId);
          const result = await invoke()(this.hostId, "fs.write.commit", write.declaration);
          this.emit({
            version: 1,
            type: "stream.committed",
            stream_id: streamId,
            path: result.path,
          });
        }
      }
    }

    class MockHostPeerConnection {
      connectionState: RTCPeerConnectionState = "new";
      remoteDescription: RTCSessionDescription | null = null;
      localDescription: RTCSessionDescription | null = null;
      onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
      onconnectionstatechange: ((event: Event) => void) | null = null;
      private channel: MockHostDataChannel | null = null;
      constructor(private readonly hostId = "") {}
      createDataChannel() {
        this.channel = new MockHostDataChannel(this.hostId);
        return this.channel as unknown as RTCDataChannel;
      }
      async createOffer() {
        return { type: "offer" as const, sdp: "mock-offer" };
      }
      async setLocalDescription(description: RTCSessionDescriptionInit) {
        this.localDescription = description as RTCSessionDescription;
      }
      async setRemoteDescription(description: RTCSessionDescriptionInit) {
        this.remoteDescription = description as RTCSessionDescription;
        this.connectionState = "connected";
        this.channel?.open();
      }
      async addIceCandidate() {}
      close() {
        this.connectionState = "closed";
        this.channel?.close();
      }
    }

    let constructingHostPeerId: string | null = null;

    class MockHostWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = MockHostWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      readonly hostId: string;
      constructor(url: string | URL) {
        this.hostId = new URL(String(url), location.href).searchParams.get("host_id") ?? "";
        setTimeout(() => {
          this.readyState = MockHostWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.emit({ type: "rtc.config", enabled: true, ice_servers: [] });
        }, 0);
      }
      send(encoded: string) {
        const message = JSON.parse(encoded) as Record<string, unknown>;
        if (message.type === "rtc.offer") {
          this.emit({ type: "rtc.answer", session_id: message.session_id, sdp: "mock-answer" });
        }
      }
      close() {
        if (this.readyState === MockHostWebSocket.CLOSED) return;
        this.readyState = MockHostWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
      private emit(values: Record<string, unknown>) {
        setTimeout(() => {
          constructingHostPeerId = this.hostId;
          try {
            this.onmessage?.(
              new MessageEvent("message", {
                data: JSON.stringify({
                  ...values,
                  scope_type: "host",
                  scope_id: this.hostId,
                  protocol: "spawn.host.ctl",
                  protocol_version: 1,
                }),
              }),
            );
          } finally {
            constructingHostPeerId = null;
          }
        }, 0);
      }
    }

    const OriginalWebSocket = globalThis.WebSocket;
    const HostAwareWebSocket = function (
      this: WebSocket,
      url: string | URL,
      protocols?: string | string[],
    ) {
      if (new URL(String(url), location.href).pathname === "/ws/host") {
        return new MockHostWebSocket(url);
      }
      return new OriginalWebSocket(url, protocols);
    } as unknown as typeof WebSocket;
    Object.assign(HostAwareWebSocket, {
      CONNECTING: WebSocket.CONNECTING,
      OPEN: WebSocket.OPEN,
      CLOSING: WebSocket.CLOSING,
      CLOSED: WebSocket.CLOSED,
    });
    globalThis.WebSocket = HostAwareWebSocket;
    const OriginalPeerConnection = globalThis.RTCPeerConnection;
    globalThis.RTCPeerConnection = function (
      this: RTCPeerConnection,
      configuration?: RTCConfiguration,
    ) {
      const hostId = constructingHostPeerId;
      return hostId
        ? new MockHostPeerConnection(hostId)
        : new OriginalPeerConnection(configuration);
    } as unknown as typeof RTCPeerConnection;
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/me") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { user: options.me ?? user },
      });
      return;
    }
    if (path === "/api/browser-devices/register" && method === "POST") {
      const body = (await request.postDataJSON()) as Record<string, string>;
      let device = browserDeviceList.find((item) => item.public_key === body.public_key);
      if (!device) {
        device = {
          // The browser's own registration always gets the stable id, even
          // when extra fixture devices are pre-seeded.
          id: browserDeviceList.some((item) => item.id === BROWSER_DEVICE_ID)
            ? `00000000-0000-4000-8000-${String(browserDeviceList.length + 9).padStart(12, "0")}`
            : BROWSER_DEVICE_ID,
          key_algorithm: "ed25519",
          // No fingerprint field (mesh B5): the real server serves the key
          // alone and the client derives any fingerprint it displays.
          public_key: body.public_key,
          label: body.label ?? null,
          created_at: CREATED_AT,
          revoked_at: null,
        };
        browserDeviceList.push(device);
      }
      await route.fulfill({ status: 200, contentType: "application/json", json: device });
      return;
    }
    if (path === "/api/browser-devices" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: browserDeviceList,
      });
      return;
    }
    const requestApprovalMatch = path.match(/^\/api\/browser-devices\/([^/]+)\/request-approval$/);
    if (requestApprovalMatch && method === "POST") {
      const body = (await request.postDataJSON()) as { public_key?: string };
      const device = browserDeviceList.find((item) => item.id === requestApprovalMatch[1]);
      if (!device) {
        await route.fulfill({ status: 404, json: { detail: "browser device not found" } });
        return;
      }
      if (device.public_key !== body.public_key) {
        await route.fulfill({ status: 409, json: { detail: "browser device changed" } });
        return;
      }
      device.approval_requested_at = new Date().toISOString();
      device.last_seen_at = device.approval_requested_at;
      await route.fulfill({ status: 200, contentType: "application/json", json: device });
      return;
    }
    const browserRevokeMatch = path.match(/^\/api\/browser-devices\/([^/]+)\/revoke$/);
    if (browserRevokeMatch && method === "POST") {
      const body = (await request.postDataJSON()) as { expected_public_key?: string };
      const device = browserDeviceList.find((item) => item.id === browserRevokeMatch[1]);
      if (!device) {
        await route.fulfill({ status: 404, json: { detail: "browser device not found" } });
        return;
      }
      if (device.public_key !== body.expected_public_key) {
        await route.fulfill({ status: 409, json: { detail: "browser device changed" } });
        return;
      }
      device.revoked_at ??= CREATED_AT;
      await route.fulfill({ status: 200, contentType: "application/json", json: device });
      return;
    }
    if (path === "/api/trust/bundle" && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", json: null });
      return;
    }
    if (path === "/api/trust/passkeys" && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", json: [] });
      return;
    }
    const hostPinsMatch = path.match(/^\/api\/trust\/hosts\/([^/]+)\/pins$/);
    if (hostPinsMatch && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: hostPinMap[hostPinsMatch[1]] ?? [],
      });
      return;
    }
    const hostPinDetailsMatch = path.match(/^\/api\/trust\/hosts\/([^/]+)\/pin-details$/);
    if (hostPinDetailsMatch && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: (hostPinMap[hostPinDetailsMatch[1]] ?? []).map((deviceId) => ({
          device_id: deviceId,
          direct: true,
          created_at: CREATED_AT,
        })),
      });
      return;
    }
    if (path === "/api/trust/account-endorsements" && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", json: [] });
      return;
    }
    if (path === "/api/trust/pairing" && method === "GET") {
      const forDevice = url.searchParams.get("device_id");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: pairingRows.filter(
          (row) => row.initiator_device_id === forDevice || row.joiner_device_id === forDevice,
        ),
      });
      return;
    }
    const pairingIntroductionsMatch = path.match(/^\/api\/trust\/pairing\/([^/]+)\/introductions$/);
    if (pairingIntroductionsMatch && method === "POST") {
      const row = pairingRows.find((item) => item.id === pairingIntroductionsMatch[1]);
      if (!row) {
        await route.fulfill({ status: 404, json: { detail: "pairing not found" } });
        return;
      }
      if (row.introductions != null) {
        await route.fulfill({ status: 409, json: { detail: "introductions already recorded" } });
        return;
      }
      const body = (await request.postDataJSON()) as {
        introductions?: unknown[];
        device_introductions?: unknown[];
      };
      const hostItems = Array.isArray(body.introductions) ? body.introductions : [];
      const deviceItems = Array.isArray(body.device_introductions) ? body.device_introductions : [];
      if (hostItems.length === 0 && deviceItems.length === 0) {
        await route.fulfill({ status: 422, json: { detail: "invalid introductions" } });
        return;
      }
      row.introductions = hostItems;
      row.device_introductions = deviceItems.length > 0 ? deviceItems : null;
      await route.fulfill({ status: 200, contentType: "application/json", json: row });
      return;
    }
    if (path === "/api/trust/host-introductions" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: hostIntroductionRows,
      });
      return;
    }
    if (path === "/api/trust/host-introductions" && method === "POST") {
      const body = (await request.postDataJSON()) as Record<string, string>;
      const publisher = browserDeviceList.find((item) => item.id === body.publisher_device_id);
      if (!publisher) {
        await route.fulfill({ status: 404, json: { detail: "publisher device not found" } });
        return;
      }
      const existing = hostIntroductionRows.find(
        (item) =>
          item.publisher_device_id === body.publisher_device_id &&
          item.host_public_key === body.host_public_key,
      );
      if (existing) {
        await route.fulfill({ status: 200, contentType: "application/json", json: existing });
        return;
      }
      const record = {
        id: `intro-${hostIntroductionRows.length + 1}`,
        publisher_device_id: body.publisher_device_id,
        publisher_public_key: String(publisher.public_key),
        host_id: body.host_id,
        host_name: body.host_name,
        host_public_key: body.host_public_key,
        signature: body.signature,
        created_at: CREATED_AT,
      };
      hostIntroductionRows.push(record);
      await route.fulfill({ status: 200, contentType: "application/json", json: record });
      return;
    }
    if (path === "/api/trust/endorsements" && method === "GET") {
      const endorsedId = url.searchParams.get("endorsed_device_id");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: options.endorsementsFor?.[endorsedId ?? ""] ?? [],
      });
      return;
    }
    if (path === "/api/trust/endorsements" && method === "POST") {
      const body = (await request.postDataJSON()) as {
        host_id: string;
        endorser_device_id: string;
        endorsed_device_id: string;
        signature: string;
      };
      const endorsed = browserDeviceList.find((item) => item.id === body.endorsed_device_id);
      if (!endorsed || typeof body.signature !== "string" || body.signature.length === 0) {
        await route.fulfill({ status: 422, json: { detail: "invalid endorsement" } });
        return;
      }
      hostPinMap[body.host_id] = [
        ...new Set([...(hostPinMap[body.host_id] ?? []), body.endorsed_device_id]),
      ];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          host_id: body.host_id,
          endorsed_device_id: body.endorsed_device_id,
          endorser_device_id: body.endorser_device_id,
          created_at: CREATED_AT,
        },
      });
      return;
    }
    const browserRenameMatch = path.match(/^\/api\/browser-devices\/([^/]+)$/);
    if (browserRenameMatch && method === "PATCH") {
      const body = (await request.postDataJSON()) as { label?: string | null };
      const device = browserDeviceList.find((item) => item.id === browserRenameMatch[1]);
      if (!device) {
        await route.fulfill({ status: 404, json: { detail: "browser device not found" } });
        return;
      }
      device.label = body.label ?? null;
      await route.fulfill({ status: 200, contentType: "application/json", json: device });
      return;
    }
    if (path === "/api/hosts") {
      await route.fulfill({ status: 200, contentType: "application/json", json: hostList });
      return;
    }
    if (path.match(/^\/api\/hosts\/[^/]+$/) && method === "GET") {
      const id = path.split("/").at(-1) ?? "";
      const match = (hostList as Array<{ id?: string }>).find((h) => h.id === id);
      await route.fulfill({
        status: match ? 200 : 404,
        contentType: "application/json",
        json: match ?? { detail: "host not found" },
      });
      return;
    }
    if (path === `/api/hosts/${HOST_ID}/tools`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { tools: [] },
      });
      return;
    }
    if (path === `/api/hosts/${HOST_ID}/dirs`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          path: url.searchParams.get("path") ?? host.home_dir,
          home_dir: host.home_dir,
          parent: "/Users",
          entries: [{ name: "projects", path: "/Users/tester/projects" }],
          error: null,
        },
      });
      return;
    }
    if (path === "/api/presets") {
      await route.fulfill({ status: 200, contentType: "application/json", json: [preset] });
      return;
    }
    if (path === "/api/skills" && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", json: skillList });
      return;
    }
    if (path === "/api/skills" && method === "POST") {
      const body = await request.postDataJSON();
      if (options.createSkill) {
        await options.createSkill(body, route);
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: skill({ ...(body as Record<string, unknown>) }),
      });
      return;
    }
    if (path.startsWith("/api/skills/") && method === "PATCH") {
      const id = path.split("/").at(-1) ?? "";
      const body = await request.postDataJSON();
      if (options.updateSkill) {
        await options.updateSkill(id, body, route);
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: skill({ id, ...(body as Record<string, unknown>) }),
      });
      return;
    }
    if (path.startsWith("/api/skills/") && method === "DELETE") {
      const id = path.split("/").at(-1) ?? "";
      if (options.deleteSkill) {
        await options.deleteSkill(id, route);
        return;
      }
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === "/api/screens" && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", json: screenList });
      return;
    }
    if (path === "/api/screens" && method === "POST") {
      const body = await request.postDataJSON();
      if (options.createScreen) {
        await options.createScreen(body, route);
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: screen({ ...(body as Record<string, unknown>) }),
      });
      return;
    }
    if (path.startsWith("/api/screens/") && method === "GET") {
      const id = path.split("/").at(-1) ?? "";
      const match = (screenList as Array<{ id?: string }>).find((v) => v.id === id);
      await route.fulfill({
        status: match ? 200 : 404,
        contentType: "application/json",
        json: match ?? { detail: "screen not found" },
      });
      return;
    }
    if (path.startsWith("/api/screens/") && method === "PATCH") {
      const id = path.split("/").at(-1) ?? "";
      const body = await request.postDataJSON();
      if (options.updateScreen) {
        await options.updateScreen(id, body, route);
        return;
      }
      const match = (screenList as Array<Record<string, unknown>>).find((v) => v.id === id);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { ...(match ?? screen()), ...(body as Record<string, unknown>) },
      });
      return;
    }
    if (path.startsWith("/api/screens/") && method === "DELETE") {
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === "/api/agents" && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", json: agents });
      return;
    }
    if (path === "/api/agents" && method === "POST") {
      if (options.createAgent) {
        await options.createAgent(await request.postDataJSON(), route);
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: agent(await request.postDataJSON()),
      });
      return;
    }
    if (path.match(/^\/api\/agents\/[^/]+$/) && method === "PATCH") {
      const id = path.split("/").at(-1) ?? "";
      const body = await request.postDataJSON();
      if (options.updateAgent) {
        await options.updateAgent(id, body, route);
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: agent({ id, ...(body as Record<string, unknown>) }),
      });
      return;
    }
    if (path === "/api/account/delete" && method === "POST") {
      const body = (await request.postDataJSON()) as {
        confirm_email?: string;
        password?: string;
      };
      if ((body.confirm_email ?? "").trim().toLowerCase() !== "tester@example.com") {
        await route.fulfill({
          status: 403,
          json: { detail: "confirmation email does not match this account" },
        });
        return;
      }
      if (body.password !== "correct horse battery") {
        await route.fulfill({ status: 403, json: { detail: "password confirmation failed" } });
        return;
      }
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (path === "/api/browser-devices/prune" && method === "POST") {
      const pruned = browserDeviceList.filter((item) => item.revoked_at != null).length;
      for (let i = browserDeviceList.length - 1; i >= 0; i -= 1) {
        if (browserDeviceList[i].revoked_at != null) browserDeviceList.splice(i, 1);
      }
      await route.fulfill({ status: 200, contentType: "application/json", json: { pruned } });
      return;
    }
    const agentGetMatch = path.match(/^\/api\/agents\/([^/]+)$/);
    if (agentGetMatch) {
      const agentGetId = agentGetMatch[1];
      const listedAgent = agents.find((item) => (item as { id?: string }).id === agentGetId);
      if (method === "GET" && listedAgent) {
        await route.fulfill({ status: 200, contentType: "application/json", json: listedAgent });
        return;
      }
      if (agentGetId === AGENT_ID) {
        await route.fulfill({ status: 200, contentType: "application/json", json: agent() });
        return;
      }
      if (method === "GET") {
        await route.fulfill({ status: 404, json: { detail: "agent not found" } });
        return;
      }
    }
    if (path === `/api/agents/${AGENT_ID}/access`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { agent_id: AGENT_ID, skills: [] },
      });
      return;
    }
    const restartMatch = path.match(/^\/api\/agents\/([^/]+)\/restart$/);
    if (restartMatch && method === "POST") {
      if (options.restartAgent) {
        await options.restartAgent(restartMatch[1], route);
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: agent({ id: restartMatch[1] }),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      json: { detail: `unmocked ${method} ${path}` },
    });
  });
}
