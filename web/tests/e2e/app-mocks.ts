import { createHash } from "node:crypto";
import type { Page, Route } from "@playwright/test";
import { autoPlace, type LayoutV2, type Rect, remove as removeTile } from "../../src/lib/grid";

export const USER_ID = "00000000-0000-4000-8000-000000000001";
export const HOST_ID = "00000000-0000-4000-8000-000000000002";
export const AGENT_ID = "00000000-0000-4000-8000-000000000003";
export const SESSION_ID = "00000000-0000-4000-8000-000000000004";
export const SKILL_ID = "00000000-0000-4000-8000-000000000006";
export const WORKSPACE_ID = "00000000-0000-4000-8000-000000000007";
export const SESSION_B_ID = "00000000-0000-4000-8000-000000000008";
export const BROWSER_DEVICE_ID = "00000000-0000-4000-8000-000000000009";
export const CREATED_AT = "2026-05-24T00:00:00Z";
const APPROVAL_NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const HOST_PUBLIC_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";

export const user = {
  id: USER_ID,
  email: "tester@example.com",
  created_at: CREATED_AT,
  email_verified_at: CREATED_AT,
  is_admin: false,
};

export const host = {
  id: HOST_ID,
  name: "Mac",
  os: "macos",
  arch: "aarch64",
  version: "0.1.0",
  status: "online",
  last_seen_at: CREATED_AT,
  session_count: 1,
  home_dir: "/Users/tester",
};

export const agentDefinition = {
  id: AGENT_ID,
  owner_user_id: null,
  name: "Codex",
  kind: "codex",
  command: "codex",
  env: {},
  install: "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
};

export function session(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    name: "palette",
    host_id: HOST_ID,
    host_name: "Mac",
    cwd: "/Users/tester/projects/spawn",
    status: "running",
    started_at: CREATED_AT,
    exited_at: null,
    last_output_at: CREATED_AT,
    last_input_at: null,
    last_activity_at: CREATED_AT,
    activity_state: "quiet",
    activity_label: "Quiet",
    exit_code: null,
    foreground_command: "zsh",
    ...overrides,
  };
}

export function agent(overrides: Record<string, unknown> = {}) {
  return { ...agentDefinition, ...overrides };
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

export function workspace(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKSPACE_ID,
    name: "daily drive",
    layout: { version: 2, tiles: [] } satisfies LayoutV2,
    position: 0,
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

type JsonRecord = Record<string, unknown>;

export interface AppMockStore {
  user: JsonRecord | null;
  config: {
    providers: Array<{ id: "google" | "microsoft" | "github"; name: string }>;
    email_verification_required: boolean;
    invite_only: boolean;
  };
  hosts: JsonRecord[];
  sessions: JsonRecord[];
  workspaces: JsonRecord[];
  agents: JsonRecord[];
  skills: JsonRecord[];
  recentDirs: Record<string, JsonRecord[]>;
  hostAgents: Record<string, JsonRecord[]>;
  sessionSkills: Record<string, string[]>;
  requests: {
    auth: JsonRecord[];
    sessions: JsonRecord[];
    workspaces: JsonRecord[];
    workspacePatches: Array<{ id: string; body: JsonRecord }>;
    agents: JsonRecord[];
  };
  setWorkspaceFull(value: boolean): void;
  failNextWorkspacePatch(status?: number, detail?: string): void;
}

export interface AppMockOptions {
  sessions?: unknown[];
  hosts?: unknown[];
  workspaces?: unknown[];
  agents?: unknown[];
  skills?: unknown[];
  config?: Partial<AppMockStore["config"]>;
  me?: Record<string, unknown> | null;
  meSequence?: Array<Record<string, unknown> | null>;
  recentDirs?: Record<string, Array<Record<string, unknown>>>;
  hostAgents?: Record<string, Array<Record<string, unknown>>>;
  sessionSkills?: Record<string, string[]>;
  workspaceFull?: boolean;
  updateWorkspace?: (
    id: string,
    body: unknown,
    route: Route,
    store: AppMockStore,
  ) => Promise<void> | void;
  createWorkspace?: (body: unknown, route: Route, store: AppMockStore) => Promise<void> | void;
  createSession?: (body: unknown, route: Route, store: AppMockStore) => Promise<void> | void;
  updateSession?: (
    id: string,
    body: unknown,
    route: Route,
    store: AppMockStore,
  ) => Promise<void> | void;
  restartSession?: (id: string, route: Route, store: AppMockStore) => Promise<void> | void;
  createAgent?: (body: unknown, route: Route, store: AppMockStore) => Promise<void> | void;
  updateAgent?: (
    id: string,
    body: unknown,
    route: Route,
    store: AppMockStore,
  ) => Promise<void> | void;
  deleteAgent?: (id: string, route: Route, store: AppMockStore) => Promise<void> | void;
  createSkill?: (body: unknown, route: Route) => Promise<void> | void;
  updateSkill?: (id: string, body: unknown, route: Route) => Promise<void> | void;
  deleteSkill?: (id: string, route: Route) => Promise<void> | void;
  files?: (hostId: string, path: string | null) => unknown;
  fileRead?: (hostId: string, path: string) => string | Uint8Array;
  fileUpload?: (hostId: string, route: Route) => Promise<void> | void;
  fileMkdir?: (hostId: string, body: unknown, route: Route) => Promise<void> | void;
  fileDelete?: (hostId: string, body: unknown, route: Route) => Promise<void> | void;
  fileRename?: (hostId: string, body: unknown, route: Route) => Promise<void> | void;
  extraBrowserDevices?: Array<Record<string, unknown>>;
  hostPins?: Record<string, string[]>;
  endorsementsFor?: Record<string, Array<Record<string, unknown>>>;
}

export async function mockApp(page: Page, options: AppMockOptions = {}): Promise<AppMockStore> {
  let workspaceFull = options.workspaceFull ?? false;
  let nextWorkspacePatchFailure: { status: number; detail: string } | null = null;
  const store: AppMockStore = {
    user: options.me === undefined ? { ...user } : options.me,
    config: {
      providers: [],
      email_verification_required: false,
      invite_only: false,
      ...options.config,
    },
    hosts: (options.hosts ?? [host]).map((item) => ({ ...(item as JsonRecord) })),
    sessions: (options.sessions ?? []).map((item) => ({ ...(item as JsonRecord) })),
    workspaces: (options.workspaces ?? [workspace()]).map((item) => ({ ...(item as JsonRecord) })),
    agents: (options.agents ?? [agent()]).map((item) => ({ ...(item as JsonRecord) })),
    skills: (options.skills ?? []).map((item) => ({ ...(item as JsonRecord) })),
    recentDirs: Object.fromEntries(
      Object.entries(options.recentDirs ?? {}).map(([id, dirs]) => [
        id,
        dirs.map((dir) => ({ ...dir })),
      ]),
    ),
    hostAgents: Object.fromEntries(
      Object.entries(options.hostAgents ?? {}).map(([id, values]) => [
        id,
        values.map((value) => ({ ...value })),
      ]),
    ),
    sessionSkills: Object.fromEntries(
      Object.entries(options.sessionSkills ?? {}).map(([id, skillIds]) => [id, [...skillIds]]),
    ),
    requests: { auth: [], sessions: [], workspaces: [], workspacePatches: [], agents: [] },
    setWorkspaceFull(value) {
      workspaceFull = value;
    },
    failNextWorkspacePatch(status = 500, detail = "layout save failed") {
      nextWorkspacePatchFailure = { status, detail };
    },
  };
  const hostList = store.hosts;
  const skillList = store.skills;
  const browserDeviceList: Array<Record<string, unknown>> = [
    ...(options.extraBrowserDevices ?? []),
  ];
  const hostPinMap: Record<string, string[]> = { ...(options.hostPins ?? {}) };

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
  let meReads = 0;
  let idCounter = 100;
  const nextId = () => `00000000-0000-4000-8000-${String(idCounter++).padStart(12, "0")}`;
  const findById = (values: JsonRecord[], id: string) => values.find((value) => value.id === id);
  const json = (route: Route, value: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", json: value });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const readBody = async (): Promise<JsonRecord> =>
      ((await request.postDataJSON()) ?? {}) as JsonRecord;

    if (path === "/api/auth/config" && method === "GET") {
      await json(route, store.config);
      return;
    }
    if (path === "/api/me" && method === "GET") {
      const sequence = options.meSequence;
      const selected = sequence?.length
        ? sequence[Math.min(meReads++, sequence.length - 1)]
        : store.user;
      if (selected === null) {
        await json(route, { detail: "not authenticated" }, 401);
      } else {
        store.user = { ...selected };
        await json(route, { user: selected });
      }
      return;
    }
    if ((path === "/api/auth/signup" || path === "/api/auth/login") && method === "POST") {
      const body = await readBody();
      store.requests.auth.push({ path, ...body });
      store.user = {
        ...user,
        email: typeof body.email === "string" ? body.email : user.email,
        email_verified_at: path.endsWith("signup") ? null : CREATED_AT,
      };
      await json(route, { access_token: "mock-token", user: store.user });
      return;
    }
    if (path === "/api/auth/logout" && method === "POST") {
      store.user = null;
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (path === "/api/auth/verify-email/request" && method === "POST") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (path === "/api/auth/device/pending" && method === "POST") {
      store.requests.auth.push({ path, ...(await readBody()) });
      const digest = createHash("sha256")
        .update(Buffer.from(HOST_PUBLIC_KEY, "base64url"))
        .digest()
        .subarray(0, 12)
        .toString("base64url");
      await json(route, {
        host_name: String(store.hosts[0]?.name ?? "Mac"),
        approval_nonce: APPROVAL_NONCE,
        host_key_algorithm: "ed25519",
        host_public_key: HOST_PUBLIC_KEY,
        host_key_fingerprint: `SHA256:${digest}`,
      });
      return;
    }
    if (path === "/api/auth/device/approve" && method === "POST") {
      const body = await readBody();
      store.requests.auth.push({ path, ...body });
      await json(route, {
        host_name: String(store.hosts[0]?.name ?? "Mac"),
        host_id: store.hosts[0]?.id ?? null,
        approval_nonce: body.approval_nonce,
        host_key_algorithm: body.host_key_algorithm,
        host_public_key: body.host_public_key,
        host_key_fingerprint: body.host_key_fingerprint,
        browser_device_id: body.browser_device_id,
        browser_key_algorithm: body.browser_key_algorithm,
        browser_public_key: body.browser_public_key,
        browser_key_fingerprint: body.browser_key_fingerprint,
      });
      return;
    }
    if (path === "/api/auth/verify-email/confirm" && method === "POST") {
      if (store.user) store.user.email_verified_at = CREATED_AT;
      await json(route, { user: store.user });
      return;
    }
    if (path === "/api/auth/password-reset/request" && method === "POST") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (path === "/api/auth/password-reset/confirm" && method === "POST") {
      await json(route, { access_token: "mock-token", user: store.user ?? user });
      return;
    }
    if (path === "/api/browser-devices/register" && method === "POST") {
      const body = (await request.postDataJSON()) as Record<string, string>;
      let device = browserDeviceList.find((item) => item.public_key === body.public_key);
      if (!device) {
        const digest = createHash("sha256")
          .update(Buffer.from(body.public_key, "base64url"))
          .digest()
          .subarray(0, 12)
          .toString("base64url");
        device = {
          // The browser's own registration always gets the stable id, even
          // when extra fixture devices are pre-seeded.
          id: browserDeviceList.some((item) => item.id === BROWSER_DEVICE_ID)
            ? `00000000-0000-4000-8000-${String(browserDeviceList.length + 9).padStart(12, "0")}`
            : BROWSER_DEVICE_ID,
          key_algorithm: "ed25519",
          public_key: body.public_key,
          fingerprint: `SHA256:${digest}`,
          label: body.label ?? null,
          created_at: CREATED_AT,
          revoked_at: null,
        };
        browserDeviceList.push(device);
      }
      await json(route, device);
      return;
    }
    if (path === "/api/browser-devices" && method === "GET") {
      await json(route, browserDeviceList);
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
      await json(route, device);
      return;
    }
    if (path === "/api/trust/bundle" && method === "GET") {
      await json(route, null);
      return;
    }
    if (path === "/api/trust/passkeys" && method === "GET") {
      await json(route, []);
      return;
    }
    const hostPinsMatch = path.match(/^\/api\/trust\/hosts\/([^/]+)\/pins$/);
    if (hostPinsMatch && method === "GET") {
      await json(route, hostPinMap[hostPinsMatch[1]] ?? []);
      return;
    }
    if (path === "/api/trust/endorsements" && method === "GET") {
      const endorsedId = url.searchParams.get("endorsed_device_id");
      await json(route, options.endorsementsFor?.[endorsedId ?? ""] ?? []);
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
      await json(route, {
        host_id: body.host_id,
        endorsed_device_id: body.endorsed_device_id,
        endorsed_key_fingerprint: endorsed.fingerprint,
        endorser_device_id: body.endorser_device_id,
        created_at: CREATED_AT,
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
      await json(route, device);
      return;
    }
    if (path === "/api/hosts" && method === "GET") {
      await json(route, hostList);
      return;
    }
    const hostMatch = path.match(/^\/api\/hosts\/([^/]+)$/);
    if (hostMatch) {
      const selected = findById(store.hosts, hostMatch[1]);
      if (!selected) {
        await json(route, { detail: "host not found" }, 404);
        return;
      }
      if (method === "GET") {
        await json(route, selected);
        return;
      }
      if (method === "PATCH") {
        Object.assign(selected, await readBody());
        await json(route, selected);
        return;
      }
      if (method === "DELETE") {
        store.hosts.splice(store.hosts.indexOf(selected), 1);
        await route.fulfill({ status: 204, body: "" });
        return;
      }
    }
    const hostAgentsMatch = path.match(/^\/api\/hosts\/([^/]+)\/agents$/);
    if (hostAgentsMatch && method === "GET") {
      await json(route, { agents: store.hostAgents[hostAgentsMatch[1]] ?? [] });
      return;
    }
    const installMatch = path.match(/^\/api\/hosts\/([^/]+)\/agents\/([^/]+)\/install$/);
    if (installMatch && method === "POST") {
      const [hostId, definitionId] = installMatch.slice(1);
      const definition = findById(store.agents, definitionId);
      store.hostAgents[hostId] ??= [];
      const statuses = store.hostAgents[hostId];
      let status = findById(statuses, definitionId);
      if (!status) {
        status = {
          agent_id: definitionId,
          agent_name: definition?.name ?? "Agent",
          agent_kind: definition?.kind ?? "custom",
          command: definition?.command ?? "agent",
        };
        statuses.push(status);
      }
      Object.assign(status, { installed: true, path: `/usr/local/bin/${status.command}` });
      await json(route, {
        ...status,
        success: true,
        exit_code: 0,
        output: "installed",
        error: null,
        status,
      });
      return;
    }
    const policyMatch = path.match(/^\/api\/hosts\/([^/]+)\/agents\/([^/]+)\/policy$/);
    if (policyMatch && method === "PATCH") {
      const body = await readBody();
      store.hostAgents[policyMatch[1]] ??= [];
      const statuses = store.hostAgents[policyMatch[1]];
      let status = findById(statuses, policyMatch[2]);
      if (!status) {
        const definition = findById(store.agents, policyMatch[2]);
        status = {
          agent_id: policyMatch[2],
          agent_name: definition?.name ?? "Agent",
          agent_kind: definition?.kind ?? "custom",
          command: definition?.command ?? "agent",
          installed: false,
        };
        statuses.push(status);
      }
      Object.assign(status, body);
      await json(route, {
        agent_id: policyMatch[2],
        auto_update: body.auto_update ?? false,
        last_checked_at: null,
        last_auto_update_at: null,
        last_auto_update_error: null,
      });
      return;
    }
    const recentMatch = path.match(/^\/api\/hosts\/([^/]+)\/recent-dirs$/);
    if (recentMatch && method === "GET") {
      await json(route, { dirs: (store.recentDirs[recentMatch[1]] ?? []).slice(0, 8) });
      return;
    }
    if (path === "/api/skills" && method === "GET") {
      await json(route, skillList);
      return;
    }
    if (path === "/api/skills" && method === "POST") {
      const body = await request.postDataJSON();
      if (options.createSkill) {
        await options.createSkill(body, route);
        return;
      }
      const created = skill({ id: nextId(), ...(body as JsonRecord) });
      store.skills.push(created);
      await json(route, created, 201);
      return;
    }
    if (path.startsWith("/api/skills/") && method === "PATCH") {
      const id = path.split("/").at(-1) ?? "";
      const body = await request.postDataJSON();
      if (options.updateSkill) {
        await options.updateSkill(id, body, route);
        return;
      }
      const selected = findById(store.skills, id);
      if (!selected) {
        await json(route, { detail: "skill not found" }, 404);
        return;
      }
      Object.assign(selected, body);
      await json(route, selected);
      return;
    }
    if (path.startsWith("/api/skills/") && method === "DELETE") {
      const id = path.split("/").at(-1) ?? "";
      if (options.deleteSkill) {
        await options.deleteSkill(id, route);
        return;
      }
      const selected = findById(store.skills, id);
      if (selected) store.skills.splice(store.skills.indexOf(selected), 1);
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (path === "/api/sessions" && method === "GET") {
      const hostId = url.searchParams.get("host_id");
      await json(
        route,
        hostId ? store.sessions.filter((item) => item.host_id === hostId) : store.sessions,
      );
      return;
    }
    if (path === "/api/sessions" && method === "POST") {
      const body = await readBody();
      store.requests.sessions.push(body);
      if (options.createSession) {
        await options.createSession(body, route, store);
        return;
      }
      const targetWorkspace =
        typeof body.workspace_id === "string"
          ? findById(store.workspaces, body.workspace_id)
          : undefined;
      let geometry = body.tile as Rect | undefined;
      let baseTiles = ((targetWorkspace?.layout as LayoutV2 | undefined)?.tiles ?? []).map(
        (tile) => ({ ...tile }),
      );
      if (targetWorkspace && !geometry) {
        const placed = autoPlace(baseTiles);
        if (workspaceFull || !placed.tile) {
          await json(route, { detail: "workspace_full" }, 409);
          return;
        }
        baseTiles = placed.tiles;
        geometry = placed.tile;
      }
      const selectedHost =
        typeof body.host_id === "string" ? findById(store.hosts, body.host_id) : undefined;
      const created = session({
        id: nextId(),
        host_id: body.host_id,
        host_name: selectedHost?.name ?? null,
        cwd: body.cwd,
        name: body.name ?? null,
      });
      store.sessions.push(created);
      if (Array.isArray(body.skill_ids)) {
        store.sessionSkills[String(created.id)] = body.skill_ids.map(String);
      }
      if (targetWorkspace && geometry) {
        targetWorkspace.layout = {
          version: 2,
          tiles: [...baseTiles, { session_id: created.id as string, ...geometry }],
        };
        targetWorkspace.updated_at = new Date().toISOString();
      }
      await json(route, created, 201);
      return;
    }
    const accessMatch = path.match(/^\/api\/sessions\/([^/]+)\/access$/);
    if (accessMatch && (method === "GET" || method === "PATCH")) {
      const body = method === "PATCH" ? await readBody() : {};
      if (method === "PATCH" && Array.isArray(body.skill_ids)) {
        store.sessionSkills[accessMatch[1]] = body.skill_ids.map(String);
      }
      const ids = store.sessionSkills[accessMatch[1]] ?? [];
      await json(route, {
        session_id: accessMatch[1],
        skills: ids.length ? store.skills.filter((item) => ids.includes(String(item.id))) : [],
      });
      return;
    }
    const restartMatch = path.match(/^\/api\/sessions\/([^/]+)\/restart$/);
    if (restartMatch && method === "POST") {
      if (options.restartSession) {
        await options.restartSession(restartMatch[1], route, store);
        return;
      }
      const selected = findById(store.sessions, restartMatch[1]);
      if (!selected) {
        await json(route, { detail: "session not found" }, 404);
        return;
      }
      Object.assign(selected, { status: "running", exited_at: null, exit_code: null });
      await json(route, selected);
      return;
    }
    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const selected = findById(store.sessions, sessionMatch[1]);
      if (!selected) {
        await json(route, { detail: "session not found" }, 404);
        return;
      }
      if (method === "GET") {
        await json(route, selected);
        return;
      }
      if (method === "PATCH") {
        const body = await readBody();
        if (options.updateSession) {
          await options.updateSession(sessionMatch[1], body, route, store);
          return;
        }
        Object.assign(selected, body);
        await json(route, selected);
        return;
      }
      if (method === "DELETE") {
        delete store.sessionSkills[sessionMatch[1]];
        store.sessions.splice(store.sessions.indexOf(selected), 1);
        for (const target of store.workspaces) {
          const layout = target.layout as LayoutV2;
          target.layout = { version: 2, tiles: removeTile(layout.tiles, sessionMatch[1]) };
        }
        await route.fulfill({ status: 204, body: "" });
        return;
      }
    }
    if (path === "/api/workspaces" && method === "GET") {
      await json(
        route,
        [...store.workspaces].sort((a, b) => Number(a.position) - Number(b.position)),
      );
      return;
    }
    if (path === "/api/workspaces" && method === "POST") {
      const body = await readBody();
      store.requests.workspaces.push(body);
      if (options.createWorkspace) {
        await options.createWorkspace(body, route, store);
        return;
      }
      const createdWorkspace: JsonRecord = workspace({
        id: nextId(),
        name: body.name ?? `Workspace ${store.workspaces.length + 1}`,
        position: store.workspaces.length,
      });
      let createdSession: JsonRecord | null = null;
      if (body.first_session && typeof body.first_session === "object") {
        const first = body.first_session as JsonRecord;
        const selectedHost =
          typeof first.host_id === "string" ? findById(store.hosts, first.host_id) : undefined;
        createdSession = session({
          id: nextId(),
          host_id: first.host_id,
          host_name: selectedHost?.name ?? null,
          cwd: first.cwd,
          name: null,
        });
        store.sessions.push(createdSession);
        if (Array.isArray(first.skill_ids)) {
          store.sessionSkills[String(createdSession.id)] = first.skill_ids.map(String);
        }
        createdWorkspace.layout = {
          version: 2,
          tiles: [{ session_id: createdSession.id as string, x: 0, y: 0, w: 12, h: 12 }],
        };
      }
      store.workspaces.push(createdWorkspace);
      await json(route, { workspace: createdWorkspace, session: createdSession }, 201);
      return;
    }
    const workspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)$/);
    if (workspaceMatch) {
      const selected = findById(store.workspaces, workspaceMatch[1]);
      if (!selected) {
        await json(route, { detail: "workspace not found" }, 404);
        return;
      }
      if (method === "GET") {
        await json(route, selected);
        return;
      }
      if (method === "PATCH") {
        const body = await readBody();
        store.requests.workspacePatches.push({ id: workspaceMatch[1], body });
        if (nextWorkspacePatchFailure) {
          const failure = nextWorkspacePatchFailure;
          nextWorkspacePatchFailure = null;
          await json(route, { detail: failure.detail }, failure.status);
          return;
        }
        if (options.updateWorkspace) {
          await options.updateWorkspace(workspaceMatch[1], body, route, store);
          return;
        }
        Object.assign(selected, body, { updated_at: new Date().toISOString() });
        await json(route, selected);
        return;
      }
      if (method === "DELETE") {
        const ids = new Set(
          ((selected.layout as LayoutV2 | undefined)?.tiles ?? []).map((tile) => tile.session_id),
        );
        for (const id of ids) delete store.sessionSkills[id];
        store.sessions.splice(
          0,
          store.sessions.length,
          ...store.sessions.filter((item) => !ids.has(String(item.id))),
        );
        store.workspaces.splice(store.workspaces.indexOf(selected), 1);
        await route.fulfill({ status: 204, body: "" });
        return;
      }
    }
    if (path === "/api/agents" && method === "GET") {
      await json(route, store.agents);
      return;
    }
    if (path === "/api/agents" && method === "POST") {
      const body = await readBody();
      store.requests.agents.push(body);
      if (options.createAgent) {
        await options.createAgent(body, route, store);
        return;
      }
      const created = agent({ id: nextId(), owner_user_id: USER_ID, ...body });
      store.agents.push(created);
      await json(route, created, 201);
      return;
    }
    const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/);
    if (agentMatch) {
      const selected = findById(store.agents, agentMatch[1]);
      if (!selected || (method !== "GET" && selected.owner_user_id === null)) {
        await json(route, { detail: "agent not found" }, 404);
        return;
      }
      if (method === "GET") {
        await json(route, selected);
        return;
      }
      if (method === "PATCH") {
        const body = await readBody();
        if (options.updateAgent) {
          await options.updateAgent(agentMatch[1], body, route, store);
          return;
        }
        Object.assign(selected, body);
        await json(route, selected);
        return;
      }
      if (method === "DELETE") {
        if (options.deleteAgent) {
          await options.deleteAgent(agentMatch[1], route, store);
          return;
        }
        store.agents.splice(store.agents.indexOf(selected), 1);
        await route.fulfill({ status: 204, body: "" });
        return;
      }
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
      await json(route, { pruned });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      json: { detail: `unmocked ${method} ${path}` },
    });
  });
  return store;
}

export async function openSettings(
  page: Page,
  tab: "account" | "appearance" | "hosts" | "agents" | "skills" | "devices" | "trust" = "account",
  workspaceId = WORKSPACE_ID,
) {
  await page.goto(`/w/${workspaceId}`);
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  if (tab !== "account") {
    await page.getByRole("button", { name: SETTINGS_TAB_LABELS[tab], exact: true }).click();
  }
}

const SETTINGS_TAB_LABELS = {
  account: "Account",
  appearance: "Appearance",
  hosts: "Hosts",
  agents: "Agents",
  skills: "Skills",
  devices: "Browser devices",
  trust: "Device trust",
} as const;
