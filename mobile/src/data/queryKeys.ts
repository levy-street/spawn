export const qk = {
  me: () => ["me"] as const,
  authConfig: () => ["auth-config"] as const,

  hosts: () => ["hosts"] as const,
  host: (hostId: string) => ["host", hostId] as const,
  hostAgents: (hostId: string) => ["host-agents", hostId] as const,

  sessions: () => ["sessions"] as const,
  sessionsForHost: (hostId: string) => ["sessions", { host_id: hostId }] as const,
  session: (sessionId: string) => ["session", sessionId] as const,

  workspaces: () => ["workspaces"] as const,
  archivedWorkspaces: () => ["workspaces", "archived"] as const,
  workspace: (workspaceId: string) => ["workspace", workspaceId] as const,
  workspaceTemplates: () => ["workspace-templates"] as const,
  workspaceIconSuggestions: (hostId: string, cwd: string) =>
    ["workspace-icon-suggestions", hostId, cwd] as const,

  agents: () => ["agents"] as const,
  skills: () => ["skills"] as const,
  profile: () => ["profile"] as const,

  adminMail: () => ["admin", "mail"] as const,
  adminEmails: () => ["admin", "emails"] as const,
  adminUsers: () => ["admin", "users"] as const,
  adminInvites: () => ["admin", "invites"] as const,

  browserDeviceRegistration: (userId: string) => ["browser-device-registration", userId] as const,
  browserDevices: () => ["browser-devices"] as const,
  browserDeviceLocalIdentity: (userId: string) =>
    ["browser-device-local-identity", userId] as const,
  browserDeviceFingerprints: (publicKeysCsv: string) =>
    ["browser-device-fingerprints", publicKeysCsv] as const,

  trust: () => ["trust"] as const,
  trustBundle: () => ["trust", "bundle"] as const,
  trustPasskeys: () => ["trust", "passkeys"] as const,
  trustStorageProbe: (accountId: string) => ["trust", "storage-probe", accountId] as const,
  trustLocalPins: (accountId: string) => ["trust", "local-pins", accountId] as const,
  trustHosts: () => ["trust", "hosts"] as const,
  trustHostPinMap: (hostIdsCsv: string) => ["trust", "host-pin-map", hostIdsCsv] as const,
  trustIntroductions: (accountId: string, deviceId: string) =>
    ["trust", "introductions", accountId, deviceId] as const,

  hostFiles: (hostId: string, path = "") => ["host-files", hostId, path] as const,
  hostFilesPage: (hostId: string, path: string, cursor: string) =>
    ["host-files", hostId, path, "page", cursor] as const,
  hostFilesForHost: (hostId: string) => ["host-files", hostId] as const,
  hostHome: (hostId: string) => ["host-home", hostId] as const,
  hostFolders: (hostId: string, path: string) => ["host-folders", hostId, path] as const,

  hostAll: (hostId: string) => [["hosts"] as const, ["host", hostId] as const] as const,
  sessionAll: (sessionId: string) =>
    [["sessions"] as const, ["session", sessionId] as const] as const,
  workspaceAll: (workspaceId: string) =>
    [["workspaces"] as const, ["workspace", workspaceId] as const] as const,
} as const;
