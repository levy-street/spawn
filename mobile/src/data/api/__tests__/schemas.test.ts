import { AdminInviteOutSchema, AdminUserOutSchema } from "@/data/api/schemas/admin";
import { AgentOutSchema } from "@/data/api/schemas/agents";
import { TokenResponseSchema } from "@/data/api/schemas/auth";
import {
  BrowserDeviceOutSchema,
  DevicePendingRequestSchema,
  DevicePendingResponseSchema,
  DevicePollResponseSchema,
} from "@/data/api/schemas/devices";
import { HostOutSchema } from "@/data/api/schemas/hosts";
import { ProfileOutSchema } from "@/data/api/schemas/legion";
import { ReleaseSchema } from "@/data/api/schemas/release";
import { SessionOutSchema } from "@/data/api/schemas/sessions";
import { SessionAccessOutSchema, SkillOutSchema } from "@/data/api/schemas/skills";
import { WorkspaceTemplateOutSchema } from "@/data/api/schemas/templates";
import {
  BrowserEndorsementRecordSchema,
  HostPinsOutSchema,
  TrustBundleOutSchema,
} from "@/data/api/schemas/trust";
import { WorkspaceOutSchema, WorkspacePatchSchema } from "@/data/api/schemas/workspaces";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-08-22T03:12:01.123456+00:00";

const user = {
  id: UUID_A,
  email: "owner@example.com",
  created_at: NOW,
  email_verified_at: null,
  is_admin: true,
};

const host = {
  id: UUID_B,
  name: "macbook",
  os: "macos",
  arch: "aarch64",
  version: "0.1.0",
  host_key_algorithm: "ed25519" as const,
  host_public_key: "host-public-key",
  status: "online",
  last_seen_at: NOW,
  session_count: 1,
  supports_account_chains: false,
  cpu_cores: 10,
  cpu_physical_cores: 10,
  cpu_model: "Apple M4",
  memory_bytes: 25_769_803_776,
  gpu: "Apple M4",
  cpu_bucket: 2,
  mem_bucket: 3,
  capacity_at: NOW,
};

const session = {
  id: UUID_C,
  name: "review",
  host_id: UUID_B,
  host_name: "macbook",
  cwd: "/Users/me/project",
  status: "running",
  started_at: NOW,
  exited_at: null,
  exit_code: null,
  last_output_at: NOW,
  last_input_at: null,
  last_activity_at: NOW,
  activity_state: "active",
  activity_label: "Active",
  foreground_command: "codex",
};

const skill = {
  id: UUID_A,
  owner_user_id: UUID_A,
  name: "Review",
  description: "Review changes",
  content: "Inspect the diff",
  enabled_by_default: false,
  created_at: NOW,
};

it("round-trips auth/account response JSON", () => {
  // The plan block rides on `UserOut` itself, so the token responses carry
  // exactly what `/api/me` carries — which is what stops a stale seeded value
  // surviving in the me-cache after sign-in. Null is what a deployment with
  // billing off sends; the shape that omits it entirely is covered in
  // `billing-schema.test.ts`, because that path gates app launch.
  const fixture = { access_token: "short-token", user: { ...user, billing: null } };
  expect(TokenResponseSchema.parse(fixture)).toEqual(fixture);
});

it("round-trips browser-device and pairing response JSON", () => {
  // No fingerprint: the server does not send one, by design. This fixture
  // used to invent one, which is how a schema that rejected every real
  // response passed its own round-trip test.
  const browserDevice = {
    id: UUID_A,
    key_algorithm: "ed25519",
    public_key: "browser-public-key",
    label: null,
    created_at: NOW,
    revoked_at: null,
  };
  expect(BrowserDeviceOutSchema.parse(browserDevice)).toEqual(browserDevice);

  const pending = {
    host_name: "macbook",
    approval_nonce: "nonce",
    host_key_algorithm: "ed25519",
    host_public_key: "host-public-key",
    host_key_fingerprint: "SHA256:host",
  };
  expect(DevicePendingResponseSchema.parse(pending)).toEqual(pending);
  expect(DevicePendingRequestSchema.parse({ approval_ref: "approval-ref-123" })).toEqual({
    approval_ref: "approval-ref-123",
  });
  expect(DevicePollResponseSchema.parse({ error: "authorization_pending" })).toEqual({
    error: "authorization_pending",
  });
});

it("round-trips host response JSON", () => {
  expect(HostOutSchema.parse(host)).toEqual({ ...host, daemon_tree: null, update: null });
  expect(
    HostOutSchema.parse({
      ...host,
      daemon_tree: "9a8b",
      update: {
        state: "available",
        latest_version: "0.1.0+gabc",
        error: null,
        requested_at: null,
      },
    }),
  ).toMatchObject({ daemon_tree: "9a8b", update: { state: "available" } });
});

it("parses the release contract and defaults identities from older servers", () => {
  expect(ReleaseSchema.parse({})).toEqual({
    server: { commit: null, dirty: false },
    web: { build_id: null },
    daemon: null,
    mobile: { tree: null, runtime_version: null },
    protocols: { daemon: null, browser: null, alerts: null },
  });
  expect(
    ReleaseSchema.parse({
      mobile: { tree: "mobile-tree", runtime_version: "0.1.0" },
      daemon: {
        version: "0.1.0+gabc",
        commit: "commit",
        tree: "daemon-tree",
        targets: {
          "darwin-aarch64": {
            spawnd_sha256: "spawnd",
            spawn_worker_sha256: "worker",
          },
        },
      },
    }),
  ).toMatchObject({
    mobile: { tree: "mobile-tree", runtime_version: "0.1.0" },
    daemon: { tree: "daemon-tree" },
  });
});

it("round-trips session and capability response JSON", () => {
  expect(SessionOutSchema.parse(session)).toEqual(session);
  expect(SkillOutSchema.parse(skill)).toEqual(skill);
  const access = { session_id: UUID_C, skills: [skill] };
  expect(SessionAccessOutSchema.parse(access)).toEqual(access);
});

it("round-trips agent response JSON", () => {
  const fixture = {
    id: UUID_A,
    owner_user_id: null,
    name: "Codex",
    kind: "codex",
    command: "codex",
    env: { TERM: "xterm-256color" },
    install: null,
    yolo_args: "--full-auto",
    yolo_env: {},
    yolo: true,
  };
  expect(AgentOutSchema.parse(fixture)).toEqual(fixture);
});

it("round-trips workspace layout response JSON", () => {
  const fixture = {
    id: UUID_A,
    name: "Project",
    host_id: UUID_B,
    cwd: "/Users/me/project",
    layout: {
      version: 3,
      active_tab: "main",
      tabs: [
        {
          id: "main",
          name: "Main",
          layout: {
            version: 3,
            tiles: [{ session_id: UUID_C, x: 0, y: 0, w: 12, h: 12 }],
          },
          host_id: UUID_B,
          cwd: "/Users/me/project",
        },
      ],
    },
    position: 0,
    icon: null,
    icon_source: "auto",
    archived_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
  expect(WorkspaceOutSchema.parse(fixture)).toEqual(fixture);
});

it("preserves optional versus explicit-null workspace patch fields", () => {
  expect(WorkspacePatchSchema.parse({})).toEqual({});
  expect(WorkspacePatchSchema.parse({ icon: null, host_id: null, cwd: null })).toEqual({
    icon: null,
    host_id: null,
    cwd: null,
  });
});

it("round-trips workspace-template response JSON", () => {
  const fixture = {
    id: UUID_A,
    name: "Agent + files",
    host_id: UUID_B,
    cwd: "/work",
    spec: {
      version: 2,
      tabs: [
        {
          name: "Main",
          tiles: [{ x: 0, y: 0, w: 12, h: 12, run: { kind: "agent", command: "codex" } }],
        },
      ],
    },
    icon: null,
    icon_source: "none",
    created_at: NOW,
    updated_at: NOW,
  };
  expect(WorkspaceTemplateOutSchema.parse(fixture)).toEqual(fixture);
});

it("round-trips trust response JSON", () => {
  const bundle = { sealed: "opaque", revision: 2, updated_at: NOW };
  expect(TrustBundleOutSchema.parse(bundle)).toEqual(bundle);
  const endorsement = {
    host_id: UUID_B,
    host_name: "macbook",
    host_public_key: "host-public-key",
    endorser_device_id: UUID_A,
    endorser_public_key: "browser-public-key",
    endorser_label: null,
    signature: "signature",
  };
  expect(BrowserEndorsementRecordSchema.parse(endorsement)).toEqual(endorsement);
  expect(
    HostPinsOutSchema.parse({
      pins: [
        {
          browser_device_id: UUID_A,
          delivered: false,
          undelivered_reason: "pin_limit",
        },
      ],
      capacity: { used: 28, max: 32 },
    }),
  ).toEqual({
    pins: [
      {
        browser_device_id: UUID_A,
        delivered: false,
        undelivered_reason: "pin_limit",
      },
    ],
    capacity: { used: 28, max: 32 },
  });
  expect(HostPinsOutSchema.parse([UUID_A])).toEqual({
    pins: [{ browser_device_id: UUID_A, delivered: true, undelivered_reason: null }],
    capacity: null,
  });
});

it("round-trips Legion/profile response JSON", () => {
  const fixture = {
    ...user,
    totals: {
      hosts: 1,
      hosts_online: 1,
      cores: 10,
      memory_bytes: 25_769_803_776,
      sessions_live: 1,
      sessions_started: 8,
      session_seconds: 3_600,
      active_days: 4,
      current_streak: 2,
      longest_streak: 3,
      peak_hosts_online: 1,
      peak_sessions: 2,
      first_day: "2026-08-01",
    },
    agents: [{ command: "codex", count: 7 }],
    days: [
      {
        day: "2026-08-22",
        sessions_started: 2,
        session_seconds: 900,
        peak_sessions: 2,
        peak_hosts_online: 1,
      },
    ],
    hosts: [
      {
        id: UUID_B,
        name: "macbook",
        os: "macos",
        status: "online",
        cpu_cores: 10,
        memory_bytes: 25_769_803_776,
        gpu: "Apple M4",
        session_count: 1,
        created_at: NOW,
        last_seen_at: NOW,
      },
    ],
    history_days: 120,
    today: "2026-08-22",
  };
  expect(ProfileOutSchema.parse(fixture)).toEqual(fixture);
});

it("round-trips admin response JSON", () => {
  const adminUser = {
    ...user,
    host_count: 1,
    session_count: 8,
    browser_device_count: 2,
  };
  expect(AdminUserOutSchema.parse(adminUser)).toEqual(adminUser);
  const invite = {
    id: UUID_B,
    email: null,
    state: "pending",
    expires_at: NOW,
    created_at: NOW,
    used_at: null,
    created_by_user_id: UUID_A,
    used_by_user_id: null,
    url: "https://spawn.example.com/signup?invite=secret",
  };
  expect(AdminInviteOutSchema.parse(invite)).toEqual(invite);
});
