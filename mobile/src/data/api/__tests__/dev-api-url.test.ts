import { deriveDevApiUrl } from "@/data/api/config";

describe("deriveDevApiUrl", () => {
  it("derives the LAN API origin from Expo's Metro host", () => {
    expect(deriveDevApiUrl("192.168.88.6:8081")).toBe("http://192.168.88.6:3000");
  });

  it("accepts a hostUri that carries a scheme or path", () => {
    expect(deriveDevApiUrl("http://192.168.88.6:8081/")).toBe("http://192.168.88.6:3000");
    expect(deriveDevApiUrl("exp://10.0.0.4:8081")).toBe("http://10.0.0.4:3000");
  });

  it("keeps a bracketed IPv6 host intact", () => {
    expect(deriveDevApiUrl("[fe80::1]:8081")).toBe("http://[fe80::1]:3000");
  });

  // Loopback is the one host that is useless here: on a phone it is the phone.
  it("declines loopback so the caller falls back", () => {
    expect(deriveDevApiUrl("localhost:8081")).toBeNull();
    expect(deriveDevApiUrl("127.0.0.1:8081")).toBeNull();
  });

  it("declines empty input", () => {
    expect(deriveDevApiUrl(undefined)).toBeNull();
    expect(deriveDevApiUrl(null)).toBeNull();
    expect(deriveDevApiUrl("")).toBeNull();
  });
});
