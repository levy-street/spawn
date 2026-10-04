import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * The workspace this device last opened, offered first wherever a window is
 * opened from outside one ("New window here…"). The browser keeps the same
 * thing under the same key (web: `localStorage["spawn.workspaces.last"]`).
 * Only an id: one that is not among the signed-in account's workspaces is
 * ignored where it is read.
 */
export const LAST_WORKSPACE_KEY = "spawn.workspaces.last";

export interface LastWorkspaceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export async function readLastWorkspace(
  storage: LastWorkspaceStorage = AsyncStorage,
): Promise<string | null> {
  try {
    return await storage.getItem(LAST_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function rememberLastWorkspace(
  workspaceId: string,
  storage: LastWorkspaceStorage = AsyncStorage,
): void {
  if (!workspaceId) return;
  void storage.setItem(LAST_WORKSPACE_KEY, workspaceId).catch(() => undefined);
}
