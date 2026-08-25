import { useSyncExternalStore } from "react";
import { Share, type ShareAction, type ShareContent, type ShareOptions } from "react-native";

/**
 * The system share sheet, with the app's window-level chrome told to step
 * aside while it is up.
 *
 * The persistent nav bar is portalled above every presented modal, and the
 * share sheet is one: presented straight over it, the sheet came up behind
 * the tabs. Every share goes through here so the bar can read whether one is
 * showing, the way it reads the camera.
 */

let sheetsOpen = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): boolean {
  return sheetsOpen > 0;
}

/** Whether a system share sheet is up. Read by the persistent nav bar. */
export function useShareSheetOpen(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

/**
 * Presents the system share sheet and resolves once it is put away, whether
 * something was shared or not. Rejections are the caller's to report.
 */
export async function presentShareSheet(
  content: ShareContent,
  options?: ShareOptions,
): Promise<ShareAction> {
  sheetsOpen += 1;
  emit();
  try {
    return await Share.share(content, options);
  } finally {
    sheetsOpen -= 1;
    emit();
  }
}
