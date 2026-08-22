import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  bytesToLowerHex,
  clearUploadOutcome,
  type DurableUploadOutcome,
  MAX_DURABLE_UPLOAD_OUTCOMES,
  reserveUploadOutcomeUnknown,
  TERMINAL_UPLOAD_OUTCOMES_KEY,
} from "@/components/terminal-ui/upload-file";

const baseRecord: DurableUploadOutcome = {
  uploadId: "00000000-0000-4000-8000-000000000001",
  name: "notes.txt",
  destination: "cwd",
  totalBytes: 12,
  sha256: "0".repeat(64),
  createdAt: 100,
};

describe("durable terminal upload outcomes", () => {
  beforeEach(() => jest.clearAllMocks());

  test("encodes digests as lowercase fixed-width hex", () => {
    expect(bytesToLowerHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe("00010f10ff");
  });

  test("durably reserves outcome_unknown before final dispatch", async () => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    await reserveUploadOutcomeUnknown(baseRecord);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      TERMINAL_UPLOAD_OUTCOMES_KEY,
      JSON.stringify([baseRecord]),
    );
  });

  test("never silently evicts one of eight unresolved uploads", async () => {
    const records = Array.from({ length: MAX_DURABLE_UPLOAD_OUTCOMES }, (_, index) => ({
      ...baseRecord,
      uploadId: `upload-${index}`,
    }));
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify(records));
    await expect(
      reserveUploadOutcomeUnknown({ ...baseRecord, uploadId: "upload-new" }),
    ).rejects.toThrow("reconciled");
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  test("clears only the acknowledged upload", async () => {
    const keep = { ...baseRecord, uploadId: "keep" };
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify([baseRecord, keep]));
    await clearUploadOutcome(baseRecord.uploadId);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      TERMINAL_UPLOAD_OUTCOMES_KEY,
      JSON.stringify([keep]),
    );
  });
});
