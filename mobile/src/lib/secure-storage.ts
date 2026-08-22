import * as SecureStore from "expo-secure-store";

// Older iOS Keychain implementations commonly reject values around 2 KiB. Keeping the
// application-side bound deterministic produces a useful error before a platform-specific one.
export const SECURE_STORAGE_MAX_VALUE_BYTES = 2_048;

const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};

function utf8Length(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        index += 1;
        continue;
      }
    }
    length += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
  }
  return length;
}

export const secureStorage = {
  get(key: string): Promise<string | null> {
    return SecureStore.getItemAsync(key, options);
  },

  async set(key: string, value: string): Promise<void> {
    const size = utf8Length(value);
    if (size > SECURE_STORAGE_MAX_VALUE_BYTES) {
      throw new RangeError(
        `Secure storage values must be at most ${SECURE_STORAGE_MAX_VALUE_BYTES} UTF-8 bytes; received ${size}`,
      );
    }
    await SecureStore.setItemAsync(key, value, options);
  },

  delete(key: string): Promise<void> {
    return SecureStore.deleteItemAsync(key, options);
  },
};
