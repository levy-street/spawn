import * as SecureStore from "expo-secure-store";

import { SECURE_STORAGE_MAX_VALUE_BYTES, secureStorage } from "@/lib/secure-storage";

describe("secureStorage", () => {
  beforeEach(() => jest.clearAllMocks());

  test("round-trips through the platform adapter", async () => {
    jest.mocked(SecureStore.getItemAsync).mockResolvedValueOnce("stored");
    await expect(secureStorage.get("key")).resolves.toBe("stored");
    await secureStorage.set("key", "value");
    await secureStorage.delete("key");
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("key", "value", expect.any(Object));
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("key", expect.any(Object));
  });

  test("rejects values above the 2 KiB UTF-8 budget", async () => {
    await expect(
      secureStorage.set("key", "x".repeat(SECURE_STORAGE_MAX_VALUE_BYTES + 1)),
    ).rejects.toThrow(/2048/);
    await expect(secureStorage.set("key", "🥝".repeat(513))).rejects.toThrow(/2052/);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });
});
