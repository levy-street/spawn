jest.mock("@/data/api/client", () => ({
  api: jest.fn(async () => undefined),
}));

jest.mock("@/data/api/auth-token", () => ({
  authToken: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
    captureFromResponse: jest.fn(async () => null),
  },
}));

jest.mock("@/data/api/config", () => ({
  getBaseUrl: jest.fn(async () => "https://spawn.example.com"),
}));

import { authToken } from "@/data/api/auth-token";
import { api } from "@/data/api/client";
import { deleteAccount } from "@/data/api/endpoints/account";
import { listAdminEmails } from "@/data/api/endpoints/admin";
import { patchAgentPreferences } from "@/data/api/endpoints/agents";
import {
  getOAuthStartUrl,
  logIn,
  renewSession,
  signOutEverywhere,
} from "@/data/api/endpoints/auth";
import { getPendingDevice } from "@/data/api/endpoints/devices";
import { patchHost, updateHost } from "@/data/api/endpoints/hosts";
import { downloadSpawnWorker } from "@/data/api/endpoints/install";
import { getProfile } from "@/data/api/endpoints/legion";
import { getRelease } from "@/data/api/endpoints/release";
import { createSession, patchSessionAccess } from "@/data/api/endpoints/sessions";
import { createSkill } from "@/data/api/endpoints/skills";
import { deleteWorkspaceTemplate } from "@/data/api/endpoints/templates";
import { listEndorsements } from "@/data/api/endpoints/trust";
import { createWorkspace } from "@/data/api/endpoints/workspaces";

const UUID_A = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  jest.mocked(api).mockClear();
  jest.mocked(authToken.clear).mockClear();
});

it("serializes the auth domain request through the shared response-capturing client", async () => {
  await logIn({ email: "owner@example.com", password: "password" });
  expect(api).toHaveBeenCalledWith(
    "/api/auth/login",
    expect.objectContaining({
      method: "POST",
      auth: false,
      body: '{"email":"owner@example.com","password":"password"}',
      schema: expect.any(Object),
    }),
  );
});

it("renews the current session and keeps the caller signed in after signing out elsewhere", async () => {
  jest.mocked(api).mockResolvedValueOnce({
    access_token: "renewed-session",
    expires_at: "2026-09-24T00:00:00Z",
  });
  await renewSession();
  expect(api).toHaveBeenLastCalledWith(
    "/api/auth/session/renew",
    expect.objectContaining({ method: "POST" }),
  );

  jest.mocked(api).mockResolvedValueOnce({ access_token: "caller-session" });
  await signOutEverywhere();
  expect(api).toHaveBeenLastCalledWith(
    "/api/auth/sign-out-everywhere",
    expect.objectContaining({ method: "POST" }),
  );
  expect(authToken.set).toHaveBeenCalledWith("caller-session");
});

it("constructs the OAuth route with an encoded return path", async () => {
  await expect(getOAuthStartUrl("github", { returnTo: "/settings?tab=account" })).resolves.toBe(
    "https://spawn.example.com/api/auth/oauth/github/start?return_to=%2Fsettings%3Ftab%3Daccount",
  );
});

it("adds the native redirect that makes the callback hand back a code", async () => {
  await expect(getOAuthStartUrl("google", { redirectUri: "spawn://auth/oauth" })).resolves.toBe(
    "https://spawn.example.com/api/auth/oauth/google/start" +
      "?return_to=%2F&redirect_uri=spawn%3A%2F%2Fauth%2Foauth",
  );
});

it("serializes the account domain and clears auth after deletion", async () => {
  await deleteAccount({ confirm_email: "owner@example.com", password: null });
  expect(api).toHaveBeenCalledWith("/api/account/delete", {
    method: "POST",
    body: '{"confirm_email":"owner@example.com","password":null}',
  });
  expect(authToken.clear).toHaveBeenCalledTimes(1);
});

it("serializes the device-pairing domain", async () => {
  await getPendingDevice({ user_code: "ABCD1234" });
  expect(api).toHaveBeenCalledWith(
    "/api/auth/device/pending",
    expect.objectContaining({ method: "POST", body: '{"user_code":"ABCD1234"}' }),
  );
});

it("encodes host identifiers and serializes host patches", async () => {
  await patchHost("host/one", { name: "Laptop" });
  expect(api).toHaveBeenCalledWith(
    "/api/hosts/host%2Fone",
    expect.objectContaining({ method: "PATCH", body: '{"name":"Laptop"}' }),
  );
});

it("requests a daemon update for an encoded host identifier", async () => {
  await updateHost("host/one");
  expect(api).toHaveBeenCalledWith(
    "/api/hosts/host%2Fone/update",
    expect.objectContaining({ method: "POST", schema: expect.any(Object) }),
  );
});

it("fetches the public release contract without auth", async () => {
  await getRelease();
  expect(api).toHaveBeenCalledWith(
    "/api/release",
    expect.objectContaining({ auth: false, schema: expect.any(Object) }),
  );
});

it("serializes session creation", async () => {
  await createSession({ host_id: UUID_A, cwd: "/work", skill_ids: null });
  expect(api).toHaveBeenCalledWith(
    "/api/sessions",
    expect.objectContaining({
      method: "POST",
      body: `{"host_id":"${UUID_A}","cwd":"/work","skill_ids":null}`,
    }),
  );
});

it("preserves null session capability semantics", async () => {
  await patchSessionAccess(UUID_A, { skill_ids: null });
  expect(api).toHaveBeenCalledWith(
    `/api/sessions/${UUID_A}/access`,
    expect.objectContaining({ method: "PATCH", body: '{"skill_ids":null}' }),
  );
});

it("serializes the skills domain", async () => {
  await createSkill({ name: "Review", content: "Review this change" });
  expect(api).toHaveBeenCalledWith(
    "/api/skills",
    expect.objectContaining({
      method: "POST",
      body: '{"name":"Review","content":"Review this change"}',
    }),
  );
});

it("serializes agent preferences", async () => {
  await patchAgentPreferences(UUID_A, { yolo: true });
  expect(api).toHaveBeenCalledWith(
    `/api/agents/${UUID_A}/preferences`,
    expect.objectContaining({ method: "PATCH", body: '{"yolo":true}' }),
  );
});

it("serializes the workspace domain", async () => {
  await createWorkspace({ name: "Project", host_id: null });
  expect(api).toHaveBeenCalledWith(
    "/api/workspaces",
    expect.objectContaining({
      method: "POST",
      body: '{"name":"Project","host_id":null}',
    }),
  );
});

it("encodes workspace template identifiers", async () => {
  await deleteWorkspaceTemplate("template/one");
  expect(api).toHaveBeenCalledWith("/api/workspace-templates/template%2Fone", {
    method: "DELETE",
  });
});

it("constructs the required endorsement filter", async () => {
  await listEndorsements(UUID_A);
  expect(api).toHaveBeenCalledWith(
    `/api/trust/endorsements?endorsed_device_id=${UUID_A}`,
    expect.objectContaining({ schema: expect.any(Object) }),
  );
});

it("calls the sole Legion/profile route", async () => {
  await getProfile();
  expect(api).toHaveBeenCalledWith(
    "/api/profile",
    expect.objectContaining({ schema: expect.any(Object) }),
  );
});

it("constructs the admin email limit", async () => {
  await listAdminEmails(250);
  expect(api).toHaveBeenCalledWith(
    "/api/admin/emails?limit=250",
    expect.objectContaining({ schema: expect.any(Object) }),
  );
});

it("requests installer bytes without auth", async () => {
  await downloadSpawnWorker("darwin-aarch64");
  expect(api).toHaveBeenCalledWith("/api/install/spawn-worker/darwin-aarch64", {
    auth: false,
    responseType: "arrayBuffer",
  });
});
