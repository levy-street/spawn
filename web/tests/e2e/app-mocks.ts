import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import type { Page, Route } from "@playwright/test";
import { autoPlace, type GridLayout, type Rect, remove as removeTile } from "../../src/lib/grid";
import { encodeSignedSignalTranscript } from "../../src/lib/signed-signal";
import { activeTab, allTiles, type LayoutV3, tabOfSession, withTabTiles } from "../../src/lib/tabs";

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
// Public test fixture, independent of the approval ceremony key below.
const RTC_TEST_KEY = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]),
  format: "der",
  type: "pkcs8",
});
const RTC_TEST_PUBLIC_KEY = createPublicKey(RTC_TEST_KEY)
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("base64url");
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
  daemon_tree: "1111111111111111111111111111111111111111",
  update: {
    state: "current",
    latest_version: "0.1.0",
    error: null,
    requested_at: null,
  },
  status: "online",
  last_seen_at: CREATED_AT,
  session_count: 1,
  home_dir: "/Users/tester",
};

export const windowsHost = {
  ...host,
  name: "Windows PC",
  os: "windows",
  arch: "x86_64",
  home_dir: "C:\\Users\\tester",
};

export const agentDefinition = {
  id: AGENT_ID,
  owner_user_id: null,
  name: "Codex",
  kind: "codex",
  command: "codex",
  env: {},
  install: "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
  yolo_args: "--dangerously-bypass-approvals-and-sandbox",
  yolo_env: {},
  yolo: false,
};

/**
 * Which keyboard the page believes is in front of it.
 *
 * The terminal and the app split the modifiers differently per platform — ⌥ is
 * the shell's word key on a Mac and the app's pane key everywhere else — so a
 * spec about chords has to state the keyboard rather than inherit whichever
 * machine is running the suite. `navigator.platform` settles both halves at
 * once: `src/lib/keyboard-chords.ts` reads it through `detectOS`, and xterm's
 * own `isMac` reads it directly. The agent goes with it because `detectOS`
 * falls back to the agent, and a Mac's agent says "Mac OS X" whatever the
 * platform claims.
 */
export async function pinKeyboard(page: Page, keyboard: "apple" | "pc") {
  const pinned =
    keyboard === "apple"
      ? {
          platform: "MacIntel",
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        }
      : {
          platform: "Win32",
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        };
  await page.addInitScript((values) => {
    Object.defineProperty(navigator, "platform", { get: () => values.platform });
    Object.defineProperty(navigator, "userAgent", { get: () => values.userAgent });
  }, pinned);
}

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
    agent_id: null,
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

/** Mirrors the server: a new workspace is named after the folder it opens in. */
function workspaceNameFromCwd(cwd: string): string | null {
  const trimmed = cwd.trim().replace(/\/+$/u, "");
  if (!trimmed) return null;
  if (trimmed === "~") return "Home";
  return trimmed.split("/").at(-1) || null;
}

/**
 * Wrap a spec's plain v2 layout into the wire's single-tab v3 envelope. The
 * tab carries the folder keys the wire always does — null, meaning it inherits
 * the workspace's home — so a spec can compare a PATCH body against this.
 */
export function envelope(layout: GridLayout, home?: { host_id: string; cwd: string }): LayoutV3 {
  return {
    version: 3,
    active_tab: "tab-1",
    tabs: [
      {
        id: "tab-1",
        name: "Tab 1",
        host_id: home?.host_id ?? null,
        cwd: home?.cwd ?? null,
        layout,
      },
    ],
  };
}

export function workspace(overrides: Record<string, unknown> = {}) {
  const { layout, ...rest } = overrides;
  // Discriminated on shape, not on a version number: the grid's version moves
  // when the canvas does, and a fixture that keys off it silently stops
  // wrapping the moment it changes.
  const wrapped =
    layout && !("tabs" in (layout as object))
      ? envelope(layout as GridLayout)
      : (layout as LayoutV3 | undefined);
  return {
    id: WORKSPACE_ID,
    name: "daily drive",
    host_id: null,
    cwd: null,
    layout: wrapped ?? envelope({ version: 3, tiles: [] }),
    position: 0,
    archived_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...rest,
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

/** Everything a current macOS daemon advertises. */
const DEFAULT_HOST_CAPABILITIES = [
  "ping",
  "fs.home",
  "fs.list",
  "fs.stat",
  "fs.read",
  "fs.read.range",
  "fs.write.begin",
  "fs.mkdir",
  "fs.rename",
  "fs.remove",
  "fs.preview",
  "desktop.reveal",
  "desktop.open",
];

/** What a daemon shipped before this feature advertises. */
export const LEGACY_HOST_CAPABILITIES = [
  "ping",
  "fs.home",
  "fs.list",
  "fs.stat",
  "fs.read",
  "fs.write.begin",
  "fs.mkdir",
  "fs.rename",
  "fs.remove",
];

/** A real 1x1 PNG, so an <img> actually decodes what the host "rendered". */
const PREVIEW_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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
  workspaceTemplates: JsonRecord[];
  skills: JsonRecord[];
  recentDirs: Record<string, JsonRecord[]>;
  hostAgents: Record<string, JsonRecord[]>;
  sessionSkills: Record<string, string[]>;
  requests: {
    auth: JsonRecord[];
    sessions: JsonRecord[];
    workspaces: JsonRecord[];
    workspacePatches: Array<{ id: string; body: JsonRecord }>;
    workspaceArchives: Array<{ id: string; restoring: boolean }>;
    agents: JsonRecord[];
  };
  setWorkspaceFull(value: boolean): void;
  failNextWorkspacePatch(status?: number, detail?: string): void;
}

export interface AppMockOptions {
  sessions?: unknown[];
  hosts?: unknown[];
  workspaces?: unknown[];
  devicePendingError?: { status: number; code?: string; message?: string; detail?: unknown };
  deviceApproveError?: { status: number; code?: string; message?: string; detail?: unknown };
  /** False models a pre-Phase-D server. */
  signOutEverywhereAvailable?: boolean;
  agents?: unknown[];
  workspaceTemplates?: JsonRecord[];
  skills?: unknown[];
  config?: Partial<AppMockStore["config"]>;
  me?: Record<string, unknown> | null;
  meSequence?: Array<Record<string, unknown> | null>;
  recentDirs?: Record<string, Array<Record<string, unknown>>>;
  hostAgents?: Record<string, Array<Record<string, unknown>>>;
  sessionSkills?: Record<string, string[]>;
  workspaceFull?: boolean;
  /** Additive `/api/release.desktop` block exposed to download surfaces. */
  releaseDesktop?: JsonRecord | null;
  /** Verified daemon target IDs exposed by the release manifest. */
  releaseDaemonTargets?: string[];
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
  /** Bytes of the PNG the host would render for a file it cannot stream. */
  filePreview?: (hostId: string, path: string, maxPixels: number) => string | Uint8Array;
  fileStat?: (hostId: string, path: string) => Record<string, unknown>;
  /** Records desktop actions so a spec can assert the exact path requested. */
  fileReveal?: (hostId: string, path: string) => void;
  fileOpen?: (hostId: string, path: string) => void;
  /**
   * What the daemon advertises. Defaults to a fully capable macOS host; a spec
   * overrides it with a legacy list to exercise the gating.
   */
  capabilities?: string[];
  fileUpload?: (hostId: string, route: Route) => Promise<void> | void;
  fileMkdir?: (hostId: string, body: unknown, route: Route) => Promise<void> | void;
  fileDelete?: (hostId: string, body: unknown, route: Route) => Promise<void> | void;
  fileRename?: (hostId: string, body: unknown, route: Route) => Promise<void> | void;
  extraBrowserDevices?: Array<Record<string, unknown>>;
  hostPins?: Record<string, string[]>;
  endorsementsFor?: Record<string, Array<Record<string, unknown>>>;
  /** Seeded add-device pairing relay rows (served by GET, mutated by the
   * introductions endpoint). Shape: DevicePairingState JSON. */
  pairings?: Array<Record<string, unknown>>;
  /** Seeded durable host-introduction rows (continuous gossip store). */
  hostIntroductions?: Array<Record<string, unknown>>;
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
    hosts: (options.hosts ?? [host]).map((item) => ({
      host_public_key: RTC_TEST_PUBLIC_KEY,
      ...(item as JsonRecord),
    })),
    sessions: (options.sessions ?? []).map((item) => ({ ...(item as JsonRecord) })),
    workspaces: (options.workspaces ?? [workspace()]).map((item) => ({ ...(item as JsonRecord) })),
    agents: (options.agents ?? [agent()]).map((item) => ({ ...(item as JsonRecord) })),
    workspaceTemplates: (options.workspaceTemplates ?? []).map((item) => ({
      ...(item as JsonRecord),
    })),
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
    requests: {
      auth: [],
      sessions: [],
      workspaces: [],
      workspacePatches: [],
      workspaceArchives: [],
      agents: [],
    },
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
  const hostPinMap: Record<string, string[]> =
    options.hostPins ??
    Object.fromEntries(
      store.hosts
        .filter((item) => item.host_public_key === RTC_TEST_PUBLIC_KEY)
        .map((item) => [String(item.id), [BROWSER_DEVICE_ID]]),
    );
  const knockRows: Array<Record<string, unknown> & { browser_device_id: string }> = [];
  const pairingRows: Array<Record<string, unknown>> = (options.pairings ?? []).map((row) => ({
    ...row,
  }));
  const hostIntroductionRows: Array<Record<string, unknown>> = (
    options.hostIntroductions ?? []
  ).map((row) => ({ ...row }));

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
      if (operation === "fs.read.range") {
        const all = Buffer.from(options.fileRead?.(hostId, String(payload.path)) ?? "hi");
        const offset = Number(payload.offset ?? 0);
        const requested = Number(payload.length ?? all.length);
        const slice = all.subarray(offset, offset + requested);
        return {
          path: payload.path,
          name:
            String(payload.path ?? "file")
              .split("/")
              .at(-1) ?? "file",
          offset,
          length: slice.length,
          file_size: all.length,
          version: `v${all.length}`,
          // The digest covers the slice, exactly as the daemon's does.
          sha256: createHash("sha256").update(slice).digest("hex"),
          content_type: "text/plain",
          content_type_source: "extension",
          preview_kind: "native",
          open_allowed: true,
          eof: offset + slice.length >= all.length,
          bytes_b64: slice.toString("base64"),
        };
      }
      if (operation === "fs.preview") {
        const bytes = Buffer.from(
          options.filePreview?.(hostId, String(payload.path), Number(payload.max_pixels)) ??
            PREVIEW_PNG,
        );
        return {
          path: payload.path,
          name:
            String(payload.path ?? "file")
              .split("/")
              .at(-1) ?? "file",
          length: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          content_type: "image/png",
          source_content_type: "application/octet-stream",
          width: Number(payload.max_pixels ?? 256),
          height: Number(payload.max_pixels ?? 256),
          version: "v1",
          bytes_b64: bytes.toString("base64"),
        };
      }
      if (operation === "desktop.reveal") {
        options.fileReveal?.(hostId, String(payload.path));
        return { path: payload.path, action: "reveal" };
      }
      if (operation === "desktop.open") {
        options.fileOpen?.(hostId, String(payload.path));
        return { path: payload.path, action: "open" };
      }
      if (operation === "fs.stat") {
        return (
          options.fileStat?.(hostId, String(payload.path)) ?? {
            path: payload.path,
            name:
              String(payload.path ?? "file")
                .split("/")
                .at(-1) ?? "file",
            kind: "file",
            size: 2,
            modified_at: 1_700_000_000,
          }
        );
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

  await page.exposeFunction(
    "__spawnSignedHostAnswer",
    (frame: Record<string, unknown>, hostId: string) => {
      const offer = JSON.parse(String(frame.signed_envelope));
      const sdp = `mock-answer:${hostId}`;
      const signature = sign(
        null,
        encodeSignedSignalTranscript({
          signalKind: "answer",
          protocolVersion: 2,
          sessionId: String(frame.session_id),
          scopeType: "host",
          scopeId: hostId,
          senderRole: "daemon",
          intendedPeerPublicKey: Buffer.from(offer.sender_identity_public_key, "base64url"),
          sdp,
        }),
        RTC_TEST_KEY,
      ).toString("base64url");
      return JSON.stringify({
        ...offer,
        type: "rtc.answer",
        sender_role: "daemon",
        sdp,
        signature,
        sender_identity_public_key: RTC_TEST_PUBLIC_KEY,
        intended_peer_identity_public_key: offer.sender_identity_public_key,
      });
    },
  );
  await page.addInitScript(
    (capabilities: string[]) => {
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
        readonly label: string;
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

        constructor(
          private readonly getHostId: () => string,
          label: string,
        ) {
          this.label = label;
        }

        open() {
          this.readyState = "open";
          this.onopen?.(new Event("open"));
          this.emit({
            version: 1,
            type: "hello",
            protocol: "spawn.host.ctl",
            capabilities,
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
              const result = await invoke()(this.getHostId(), operation, payload);
              if (
                operation === "fs.read" ||
                operation === "fs.read.range" ||
                operation === "fs.preview"
              ) {
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
                // The client rejects any chunk over 8 KiB by tearing down the
                // channel, and it requires strictly increasing sequence numbers.
                // Emitting a whole file as one frame silently capped every
                // fixture at 8 KiB, so anything larger has to be split here the
                // way the daemon splits it.
                const CHUNK_BYTES = 8 * 1024;
                const binary = bytes ? atob(bytes) : "";
                let sequence = 0;
                for (let offset = 0; offset < binary.length; offset += CHUNK_BYTES) {
                  this.emit({
                    version: 1,
                    type: "stream.chunk",
                    stream_id: streamId,
                    sequence,
                    bytes_b64: btoa(binary.slice(offset, offset + CHUNK_BYTES)),
                  });
                  sequence += 1;
                }
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
            const result = await invoke()(this.getHostId(), "fs.write.commit", write.declaration);
            this.emit({
              version: 1,
              type: "stream.committed",
              stream_id: streamId,
              path: result.path,
            });
          }
        }
      }

      type SessionMock = {
        makeChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel;
        peerCreated(): void;
        openChannels: boolean;
      };
      const sessionMock = () =>
        (globalThis as typeof globalThis & { __spawnSessionMock?: SessionMock }).__spawnSessionMock;
      const peers: MockHostPeerConnection[] = [];
      (globalThis as typeof globalThis & { __spawnHostMock: unknown }).__spawnHostMock = {
        count: () => peers.length,
        disconnect: () => peers.find((peer) => peer.connectionState === "connected")?.close(),
      };
      class MockHostPeerConnection {
        connectionState: RTCPeerConnectionState = "new";
        iceConnectionState: RTCIceConnectionState = "new";
        remoteDescription: RTCSessionDescription | null = null;
        localDescription: RTCSessionDescription | null = null;
        onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
        onconnectionstatechange: ((event: Event) => void) | null = null;
        oniceconnectionstatechange: (() => void) | null = null;
        private channels: Array<MockHostDataChannel | RTCDataChannel> = [];
        private hostId = "";
        constructor() {
          peers.push(this);
          sessionMock()?.peerCreated();
        }
        createDataChannel(label: string, options?: RTCDataChannelInit) {
          const channel = label.startsWith("spawn.host.ctl")
            ? new MockHostDataChannel(() => this.hostId, label)
            : sessionMock()?.makeChannel(label, options);
          if (!channel) throw new Error(`No mock for ${label}`);
          this.channels.push(channel);
          if (this.connectionState === "connected")
            queueMicrotask(() => (channel as unknown as { open(): void }).open());
          return channel as RTCDataChannel;
        }
        async createOffer() {
          return { type: "offer" as const, sdp: `v=0\r\na=ice-ufrag:${crypto.randomUUID()}\r\n` };
        }
        async setLocalDescription(description: RTCSessionDescriptionInit) {
          this.localDescription = description as RTCSessionDescription;
        }
        async setRemoteDescription(description: RTCSessionDescriptionInit) {
          this.remoteDescription = description as RTCSessionDescription;
          this.hostId = description.sdp?.slice("mock-answer:".length) ?? "";
          if (sessionMock()?.openChannels === false) return;
          this.connectionState = "connected";
          this.iceConnectionState = "connected";
          for (const channel of this.channels) (channel as unknown as { open(): void }).open();
          this.onconnectionstatechange?.(new Event("connectionstatechange"));
        }
        async getStats() {
          return new Map();
        }
        async addIceCandidate() {}
        close() {
          this.connectionState = "closed";
          for (const channel of this.channels) channel.close();
        }
      }

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
            this.emit({
              type: "rtc.config",
              enabled: true,
              ice_servers: [],
              binding_nonce_required: true,
            });
          }, 0);
        }
        send(encoded: string) {
          const message = JSON.parse(encoded) as Record<string, unknown>;
          if (message.type === "rtc.offer") {
            void (
              globalThis as typeof globalThis & {
                __spawnRecordRtcTestMessage?: (label: string, value: string) => Promise<void>;
              }
            ).__spawnRecordRtcTestMessage?.("signal", JSON.stringify(message));
            void (
              globalThis as typeof globalThis & {
                __spawnSignedHostAnswer(
                  frame: Record<string, unknown>,
                  hostId: string,
                ): Promise<string>;
              }
            )
              .__spawnSignedHostAnswer(message, this.hostId)
              .then((signed_envelope) => {
                this.emit({
                  type: "rtc.answer",
                  session_id: message.session_id,
                  binding_nonce: message.binding_nonce ?? crypto.randomUUID().replaceAll("-", ""),
                  binding_generation: 1,
                  signed_envelope,
                });
              });
          }
        }
        close() {
          if (this.readyState === MockHostWebSocket.CLOSED) return;
          this.readyState = MockHostWebSocket.CLOSED;
          this.onclose?.(new CloseEvent("close"));
        }
        private emit(values: Record<string, unknown>) {
          setTimeout(() => {
            this.onmessage?.(
              new MessageEvent("message", {
                data: JSON.stringify({
                  ...values,
                  scope_type: "host",
                  scope_id: this.hostId,
                  protocol: "spawn.host.ctl",
                  protocol_version: 2,
                }),
              }),
            );
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
      globalThis.RTCPeerConnection = MockHostPeerConnection as unknown as typeof RTCPeerConnection;
    },
    ["session.transport.v1", ...(options.capabilities ?? DEFAULT_HOST_CAPABILITIES)],
  );
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
    if (path === "/api/auth/sign-out-everywhere" && method === "POST") {
      store.requests.auth.push({ path, ...(await readBody()) });
      if (options.signOutEverywhereAvailable === false) {
        await json(route, { detail: "not found" }, 404);
        return;
      }
      await json(route, { access_token: "fresh-session-token" });
      return;
    }
    if (path === "/api/auth/verify-email/request" && method === "POST") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (path === "/api/auth/device/pending" && method === "POST") {
      store.requests.auth.push({ path, ...(await readBody()) });
      if (options.devicePendingError) {
        await json(route, options.devicePendingError, options.devicePendingError.status);
        return;
      }
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
      if (options.deviceApproveError) {
        await json(route, options.deviceApproveError, options.deviceApproveError.status);
        return;
      }
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
    const requestApprovalMatch = path.match(/^\/api\/browser-devices\/([^/]+)\/request-approval$/);
    if (requestApprovalMatch && method === "POST") {
      // Advisory only — it stamps "this device is asking", never authorization.
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
      await json(route, device);
      return;
    }
    // The knock (docs/TRUST_UX.md §3): a pending row per asking device, served
    // to every screen of the account and answered by an endorsement elsewhere.
    if (path === "/api/trust/device-approvals" && method === "GET") {
      await json(route, knockRows);
      return;
    }
    if (path === "/api/trust/device-approvals" && method === "POST") {
      const body = (await request.postDataJSON()) as { browser_device_id?: string };
      const device = browserDeviceList.find((item) => item.id === body.browser_device_id);
      if (!device) {
        await route.fulfill({ status: 404, json: { detail: "browser device not found" } });
        return;
      }
      const digest = createHash("sha256")
        .update(Buffer.from(device.public_key as string, "base64url"))
        .digest()
        .subarray(0, 12)
        .toString("base64url");
      const existing = knockRows.find((row) => row.browser_device_id === device.id);
      const row = existing ?? {
        id: `00000000-0000-4000-8000-${String(knockRows.length + 900).padStart(12, "0")}`,
        browser_device_id: device.id as string,
        label: (device.label as string | null | undefined) ?? null,
        fingerprint: `SHA256:${digest}`,
        status: "pending",
        created_at: CREATED_AT,
        expires_at: "2099-01-01T00:00:00Z",
      };
      if (!existing) knockRows.push(row);
      await json(route, row);
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
    const hostPinDetailsMatch = path.match(/^\/api\/trust\/hosts\/([^/]+)\/pin-details$/);
    if (hostPinDetailsMatch && method === "GET") {
      const pinned = hostPinMap[hostPinDetailsMatch[1]] ?? [];
      await json(
        route,
        pinned.map((deviceId) => {
          const device = browserDeviceList.find((item) => item.id === deviceId);
          return {
            browser_device_id: deviceId,
            browser_public_key: device?.public_key ?? null,
            endorser_device_id: null,
            direct: true,
            created_at: CREATED_AT,
          };
        }),
      );
      return;
    }
    if (path === "/api/trust/account-endorsements" && method === "GET") {
      await json(route, []);
      return;
    }
    if (path === "/api/trust/pairing" && method === "POST") {
      // Initiator opens a ceremony; the joiner discovers it by polling.
      const body = (await request.postDataJSON()) as Record<string, string>;
      const row = {
        id: `00000000-0000-4000-8000-${String(pairingRows.length + 700).padStart(12, "0")}`,
        initiator_device_id: body.initiator_device_id,
        joiner_device_id: body.joiner_device_id,
        initiator_public_key: body.initiator_public_key,
        initiator_commit: body.initiator_commit,
        joiner_public_key: null,
        joiner_nonce: null,
        initiator_nonce: null,
        introductions: null,
        device_introductions: null,
        created_at: CREATED_AT,
        expires_at: "2099-01-01T00:00:00Z",
      };
      pairingRows.push(row);
      await json(route, { id: row.id, expires_at: row.expires_at });
      return;
    }
    if (path === "/api/trust/pairing" && method === "GET") {
      const forDevice = url.searchParams.get("device_id");
      await json(
        route,
        pairingRows.filter(
          (row) => row.initiator_device_id === forDevice || row.joiner_device_id === forDevice,
        ),
      );
      return;
    }
    const pairingIntroductionsMatch = path.match(/^\/api\/trust\/pairing\/([^/]+)\/introductions$/);
    if (pairingIntroductionsMatch && method === "POST") {
      const row = pairingRows.find((item) => item.id === pairingIntroductionsMatch[1]);
      if (!row) {
        await route.fulfill({ status: 404, json: { detail: "pairing not found" } });
        return;
      }
      // Set-once, like the server: a second write is a conflict, never a
      // silent overwrite of statements a peer may already have verified.
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
      await json(route, row);
      return;
    }
    if (path === "/api/trust/host-introductions" && method === "GET") {
      await json(route, hostIntroductionRows);
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
        await json(route, existing);
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
      await json(route, record);
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
      // Mesh B5: the server serves no fingerprint next to a key — clients
      // derive the display value locally from the key they verified.
      await json(route, {
        host_id: body.host_id,
        endorsed_device_id: body.endorsed_device_id,
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
    if (path === "/api/release" && method === "GET") {
      const releaseTargets = options.releaseDaemonTargets ?? [];
      await json(route, {
        server: { commit: null, dirty: false },
        web: { build_id: null },
        daemon:
          releaseTargets.length > 0
            ? {
                commit: "1".repeat(40),
                tree: "2".repeat(40),
                version: "0.2.0",
                targets: Object.fromEntries(releaseTargets.map((target) => [target, {}])),
              }
            : null,
        mobile: { tree: null, runtime_version: null },
        desktop: options.releaseDesktop ?? null,
        protocols: { daemon: null, browser: null, alerts: null },
      });
      return;
    }
    const hostUpdateMatch = path.match(/^\/api\/hosts\/([^/]+)\/update$/);
    if (hostUpdateMatch && method === "POST") {
      const selected = findById(store.hosts, hostUpdateMatch[1]);
      if (!selected) {
        await json(route, { detail: "host not found" }, 404);
        return;
      }
      const update = {
        state: "current",
        latest_version: selected.version ?? null,
        error: null,
        requested_at: new Date().toISOString(),
      };
      selected.update = update;
      await json(route, { update });
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
      const targetLayout = targetWorkspace?.layout as LayoutV3 | undefined;
      const targetTab = targetLayout ? activeTab(targetLayout) : undefined;
      let geometry = body.tile as Rect | undefined;
      let baseTiles = (targetTab?.layout.tiles ?? []).map((tile) => ({ ...tile }));
      // A forced-full workspace refuses whether or not the caller named a
      // rect: the real server has no room for either.
      if (targetWorkspace && workspaceFull) {
        await json(route, { detail: "workspace_full" }, 409);
        return;
      }
      if (targetWorkspace && !geometry) {
        const placed = autoPlace(baseTiles);
        if (!placed.tile) {
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
        // The window's recorded type, as the server keeps it: what a duplicate
        // is copied as, whatever the shell's foreground says a moment later.
        agent_id: typeof body.agent_id === "string" ? body.agent_id : null,
      });
      store.sessions.push(created);
      if (Array.isArray(body.skill_ids)) {
        store.sessionSkills[String(created.id)] = body.skill_ids.map(String);
      }
      if (targetWorkspace && targetLayout && targetTab && geometry) {
        targetWorkspace.layout = withTabTiles(targetLayout, targetTab.id, [
          ...baseTiles,
          { session_id: created.id as string, ...geometry },
        ]);
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
          const layout = target.layout as LayoutV3;
          const holder = tabOfSession(layout, sessionMatch[1]);
          if (holder) {
            target.layout = withTabTiles(
              layout,
              holder.id,
              removeTile(holder.layout.tiles, sessionMatch[1]),
            );
          }
        }
        await route.fulfill({ status: 204, body: "" });
        return;
      }
    }
    if (path === "/api/workspaces" && method === "GET") {
      if (url.searchParams.get("archived") === "true") {
        await json(
          route,
          store.workspaces
            .filter((item) => item.archived_at !== null)
            .sort((a, b) => String(b.archived_at).localeCompare(String(a.archived_at))),
        );
        return;
      }
      await json(
        route,
        store.workspaces
          .filter((item) => item.archived_at === null)
          .sort((a, b) => Number(a.position) - Number(b.position)),
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
      const first =
        body.first_session && typeof body.first_session === "object"
          ? (body.first_session as JsonRecord)
          : null;
      // The home comes from `first_session` when one is asked for, else from
      // the top-level pair — a blank workspace is created homed but empty.
      const homeHostId = first?.host_id ?? body.host_id ?? null;
      const homeCwd = first?.cwd ?? body.cwd ?? null;
      const createdWorkspace: JsonRecord = workspace({
        id: nextId(),
        name:
          body.name ??
          workspaceNameFromCwd(typeof homeCwd === "string" ? homeCwd : "") ??
          `Workspace ${store.workspaces.length + 1}`,
        position: store.workspaces.length,
        host_id: homeHostId,
        cwd: homeCwd,
      });
      let createdSession: JsonRecord | null = null;
      if (first) {
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
        createdWorkspace.layout = envelope({
          version: 3,
          tiles: [{ session_id: createdSession.id as string, x: 0, y: 0, w: 24, h: 24 }],
        });
      }
      store.workspaces.push(createdWorkspace);
      await json(route, { workspace: createdWorkspace, session: createdSession }, 201);
      return;
    }
    const archiveMatch = path.match(/^\/api\/workspaces\/([^/]+)\/(un)?archive$/);
    if (archiveMatch && method === "POST") {
      const selected = findById(store.workspaces, archiveMatch[1]);
      if (!selected) {
        await json(route, { detail: "workspace not found" }, 404);
        return;
      }
      const restoring = archiveMatch[2] === "un";
      store.requests.workspaceArchives.push({ id: String(selected.id), restoring });
      const ids = new Set(allTiles(selected.layout as LayoutV3).map((tile) => tile.session_id));
      if (restoring) {
        selected.archived_at = null;
        // Reinsertion at the remembered slot: `position` never stopped
        // holding this row's old place while it was away.
        const rest = store.workspaces
          .filter((item) => item.archived_at === null && item.id !== selected.id)
          .sort((a, b) => Number(a.position) - Number(b.position));
        rest.splice(Math.min(Number(selected.position), rest.length), 0, selected);
        rest.forEach((item, index) => {
          item.position = index;
        });
        // The same sessions start again, under the same ids.
        for (const item of store.sessions) {
          if (ids.has(String(item.id))) item.status = "starting";
        }
      } else {
        // Suspend, not teardown: the windows stop, the layout is untouched.
        for (const item of store.sessions) {
          if (ids.has(String(item.id))) {
            item.status = "killed";
            item.foreground_command = null;
          }
        }
        selected.archived_at = new Date().toISOString();
        // Archiving closes the gap it made in the sidebar's ordering, and
        // leaves the archived row's own position alone.
        store.workspaces
          .filter((item) => item.archived_at === null)
          .sort((a, b) => Number(a.position) - Number(b.position))
          .forEach((item, index) => {
            item.position = index;
          });
      }
      await json(route, selected);
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
        const ids = new Set(allTiles(selected.layout as LayoutV3).map((tile) => tile.session_id));
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
    if (path === "/api/workspace-templates" && method === "GET") {
      await json(route, store.workspaceTemplates);
      return;
    }
    if (path === "/api/workspace-templates" && method === "POST") {
      const body = await readBody();
      const created = {
        id: nextId(),
        created_at: "2026-08-19T00:00:00Z",
        updated_at: "2026-08-19T00:00:00Z",
        ...body,
      };
      store.workspaceTemplates.push(created);
      await json(route, created, 201);
      return;
    }
    const templateMatch = path.match(/^\/api\/workspace-templates\/([^/]+)$/);
    if (templateMatch) {
      const selected = findById(store.workspaceTemplates, templateMatch[1]);
      if (!selected) {
        await json(route, { detail: "template not found" }, 404);
        return;
      }
      if (method === "PATCH") {
        Object.assign(selected, await readBody());
        await json(route, selected);
        return;
      }
      if (method === "DELETE") {
        store.workspaceTemplates.splice(store.workspaceTemplates.indexOf(selected), 1);
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
    const agentPreferencesMatch = path.match(/^\/api\/agents\/([^/]+)\/preferences$/);
    if (agentPreferencesMatch && method === "PATCH") {
      const selected = findById(store.agents, agentPreferencesMatch[1]);
      if (!selected) {
        await json(route, { detail: "agent not found" }, 404);
        return;
      }
      // Built-ins accept this where PATCH on the definition would 404: the row
      // written server-side is the caller's preference, not the definition.
      Object.assign(selected, await readBody());
      await json(route, selected);
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
  tab:
    | "account"
    | "appearance"
    | "notifications"
    | "agents"
    | "skills"
    | "templates"
    | "access" = "account",
  workspaceId = WORKSPACE_ID,
  /**
   * Where to open Settings from. Defaults to a workspace, which is what a real
   * operator does — but a workspace is a live-terminal surface, so on a device
   * the account has not approved the session-approval gate legitimately covers
   * it (docs/TRUST_UX.md §3). Specs that deliberately run an unapproved device
   * pass a neutral route instead of weakening the gate.
   */
  landOn = `/w/${workspaceId}`,
) {
  await page.goto(landOn);
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  if (tab !== "account") {
    await page.getByRole("button", { name: SETTINGS_TAB_LABELS[tab], exact: true }).click();
  }
}

const SETTINGS_TAB_LABELS = {
  account: "Account",
  appearance: "Appearance",
  notifications: "Notifications",
  hosts: "Hosts",
  agents: "Agents",
  skills: "Skills",
  templates: "Templates",
  // "Browser devices" and "Device trust" merged into one Access tab (mesh v5).
  access: "Access",
} as const;
