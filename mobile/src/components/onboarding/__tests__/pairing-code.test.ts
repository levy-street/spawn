import {
  formatPairingCodeInput,
  pairingCodeError,
  pairingCodeForRequest,
} from "@/components/onboarding/pairing-code";
import { validationCopy } from "@/lib/validation";

describe("pairing code input", () => {
  it("uppercases and presents eight characters as a clear 4-4 code", () => {
    expect(formatPairingCodeInput("qz4k7hmt")).toBe("QZ4K-7HMT");
    expect(formatPairingCodeInput(" qz4k 7hmt ")).toBe("QZ4K-7HMT");
    expect(formatPairingCodeInput("QZ4K-7HMTEXTRA")).toBe("QZ4K-7HMT");
  });

  it("uses the shared eight-character alphabet validator", () => {
    expect(pairingCodeError("QZ4K-7HMT")).toBeNull();
    expect(pairingCodeError("OZ4K-7HMT")).toBe(validationCopy.hostPairingCode);
    expect(pairingCodeError("QZ4K-7HM")).toBe(validationCopy.hostPairingCode);
  });

  it("sends the normalized eight-character wire value", () => {
    expect(pairingCodeForRequest("qz4k-7hmt")).toBe("QZ4K7HMT");
    expect(() => pairingCodeForRequest("invalid")).toThrow(validationCopy.hostPairingCode);
  });
});
