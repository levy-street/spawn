import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiConfig, getBaseUrl, setBaseUrl } from "@/data/api/config";

beforeEach(async () => {
  jest.mocked(AsyncStorage.setItem).mockResolvedValue(undefined);
  jest.mocked(AsyncStorage.removeItem).mockResolvedValue(undefined);
  await setBaseUrl(null);
  jest.clearAllMocks();
});

it("falls back to the compiled development origin", async () => {
  await expect(getBaseUrl()).resolves.toBe(apiConfig.defaultBaseUrl);
});

it("normalizes and persists a runtime override", async () => {
  await setBaseUrl(" https://spawn.example.com/// ");
  await expect(getBaseUrl()).resolves.toBe("https://spawn.example.com");
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    "spawn.api.base-url.v1",
    "https://spawn.example.com",
  );
});

it("clears a runtime override", async () => {
  await setBaseUrl("https://spawn.example.com");
  await setBaseUrl(null);
  await expect(getBaseUrl()).resolves.toBe(apiConfig.defaultBaseUrl);
  expect(AsyncStorage.removeItem).toHaveBeenCalledWith("spawn.api.base-url.v1");
});

it.each(["spawn.example.com", "ftp://spawn.example.com", "https://user:pass@spawn.example.com"])(
  "rejects invalid override %s",
  async (value) => {
    await expect(setBaseUrl(value)).rejects.toThrow();
  },
);
