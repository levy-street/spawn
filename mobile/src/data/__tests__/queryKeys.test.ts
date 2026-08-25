import { qk } from "@/data/queryKeys";

describe("query key registry", () => {
  it("matches the frozen core tuple contract", () => {
    const me: readonly ["me"] = qk.me();
    const host: readonly ["host", string] = qk.host("host-id");
    const session: readonly ["session", string] = qk.session("session-id");
    const workspace: readonly ["workspace", string] = qk.workspace("workspace-id");

    expect(me).toEqual(["me"]);
    expect(host).toEqual(["host", "host-id"]);
    expect(session).toEqual(["session", "session-id"]);
    expect(workspace).toEqual(["workspace", "workspace-id"]);
  });

  it("ships every scoped registry key with stable values", () => {
    const keys = [
      qk.me(),
      qk.authConfig(),
      qk.release(),
      qk.hosts(),
      qk.host("host"),
      qk.hostAgents("host"),
      qk.sessions(),
      qk.sessionsForHost("host"),
      qk.session("session"),
      qk.workspaces(),
      qk.archivedWorkspaces(),
      qk.workspace("workspace"),
      qk.workspaceTemplates(),
      qk.workspaceIconSuggestions("host", "/cwd"),
      qk.agents(),
      qk.skills(),
      qk.profile(),
      qk.adminMail(),
      qk.adminEmails(),
      qk.adminUsers(),
      qk.adminInvites(),
      qk.browserDeviceRegistration("user"),
      qk.browserDevices(),
      qk.browserDeviceLocalIdentity("user"),
      qk.browserDeviceFingerprints("keys"),
      qk.trust(),
      qk.trustBundle(),
      qk.trustPasskeys(),
      qk.trustStorageProbe("account"),
      qk.trustLocalPins("account"),
      qk.trustHosts(),
      qk.trustHostPinMap("hosts"),
      qk.trustIntroductions("account", "device"),
      qk.hostFiles("host"),
      qk.hostFilesPage("host", "/cwd", "cursor"),
      qk.hostFilesForHost("host"),
      qk.hostHome("host"),
      qk.hostFolders("host", "/cwd"),
    ];
    const serialized = keys.map((key) => JSON.stringify(key));

    expect(new Set(serialized).size).toBe(serialized.length);
    expect(qk.sessionsForHost("host")).toEqual(qk.sessionsForHost("host"));
    expect(qk.hostFiles("host")).toEqual(["host-files", "host", ""]);
  });

  it("groups list prefixes with matching detail keys for invalidation", () => {
    expect(qk.hostAll("host")).toEqual([qk.hosts(), qk.host("host")]);
    expect(qk.sessionAll("session")).toEqual([qk.sessions(), qk.session("session")]);
    expect(qk.workspaceAll("workspace")).toEqual([qk.workspaces(), qk.workspace("workspace")]);
    expect(qk.hostFilesForHost("host")).toEqual(["host-files", "host"]);
    expect(qk.trust()).toEqual(["trust"]);
  });
});
