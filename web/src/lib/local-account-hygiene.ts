import {
  type BrowserDeviceIdentityStorageOptions,
  deleteBrowserDeviceIdentity,
  loadBrowserDeviceIdentity,
} from "./browser-device-identity";
import {
  type BrowserHostPinStorageOptions,
  forgetActiveBrowserHostPins,
} from "./browser-host-pins";
import { forgetPeerDeviceKeys } from "./peer-device-keys";
import { forgetFirsthandRoot } from "./root-knowledge";

export interface LocalAccountHygieneStorage {
  identity?: BrowserDeviceIdentityStorageOptions;
  hostPins?: BrowserHostPinStorageOptions;
  peerKeys?: BrowserHostPinStorageOptions;
  rootKnowledge?: BrowserHostPinStorageOptions;
}

/**
 * Remove one account's usable local material. Targeted host-removal records
 * survive because forgetActiveBrowserHostPins deletes active records only.
 * The trust-revision database is intentionally absent: its rollback floor is
 * permanent local safety state and must survive every account cleanup.
 */
export async function removeAccountFromThisBrowser(
  input: { accountId: string; origin: string },
  storage: LocalAccountHygieneStorage = {},
): Promise<{ hostApprovals: number; peerDevices: number; identity: boolean }> {
  const identity = await loadBrowserDeviceIdentity(input.accountId, storage.identity ?? {});

  // Delete the identity last. If another database is unavailable, the browser
  // retains its signer and can retry instead of being left in a half-cleaned,
  // automatically regenerated state.
  const hostApprovals = await forgetActiveBrowserHostPins(input, storage.hostPins ?? {});
  const peerDevices = await forgetPeerDeviceKeys(input, storage.peerKeys ?? {});
  await forgetFirsthandRoot(input, storage.rootKnowledge ?? {});
  const identityDeleted =
    identity === null
      ? false
      : await deleteBrowserDeviceIdentity(
          input.accountId,
          identity.publicKeyWire,
          storage.identity ?? {},
        );
  return {
    hostApprovals: hostApprovals.forgotten,
    peerDevices: peerDevices.forgotten,
    identity: identityDeleted,
  };
}
