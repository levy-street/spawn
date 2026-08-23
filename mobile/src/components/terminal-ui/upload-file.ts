import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";

import type { UploadRequest } from "@/terminal/transport/types";
import { SESSION_UPLOAD_MAX_BYTES } from "@/terminal/transport/upload";

export const TERMINAL_UPLOAD_OUTCOMES_KEY = "spawn.terminal-upload-outcomes";
export const MAX_DURABLE_UPLOAD_OUTCOMES = 8;

export interface DurableUploadOutcome {
  uploadId: string;
  name: string;
  destination: "attachments" | "cwd";
  totalBytes: number;
  sha256: string;
  createdAt: number;
}

function isDurableUploadOutcome(value: unknown): value is DurableUploadOutcome {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item["uploadId"] === "string" &&
    typeof item["name"] === "string" &&
    (item["destination"] === "attachments" || item["destination"] === "cwd") &&
    typeof item["totalBytes"] === "number" &&
    typeof item["sha256"] === "string" &&
    typeof item["createdAt"] === "number"
  );
}

async function readDurableOutcomes(): Promise<DurableUploadOutcome[]> {
  const encoded = await AsyncStorage.getItem(TERMINAL_UPLOAD_OUTCOMES_KEY);
  if (!encoded) return [];
  try {
    const parsed: unknown = JSON.parse(encoded);
    return Array.isArray(parsed) ? parsed.filter(isDurableUploadOutcome) : [];
  } catch {
    return [];
  }
}

export async function reserveUploadOutcomeUnknown(record: DurableUploadOutcome): Promise<void> {
  const records = await readDurableOutcomes();
  const existing = records.findIndex((item) => item.uploadId === record.uploadId);
  if (existing >= 0) records[existing] = record;
  else {
    if (records.length >= MAX_DURABLE_UPLOAD_OUTCOMES) {
      throw new Error("Unresolved terminal uploads must be reconciled before uploading again.");
    }
    records.push(record);
  }
  await AsyncStorage.setItem(TERMINAL_UPLOAD_OUTCOMES_KEY, JSON.stringify(records));
}

export async function clearUploadOutcome(uploadId: string): Promise<void> {
  const records = await readDurableOutcomes();
  const next = records.filter((record) => record.uploadId !== uploadId);
  if (next.length === records.length) return;
  await AsyncStorage.setItem(TERMINAL_UPLOAD_OUTCOMES_KEY, JSON.stringify(next));
}

export function bytesToLowerHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The common ground between a document-picker asset and an image-picker one. */
export interface TerminalUploadAsset {
  uri: string;
  name: string;
  mimeType?: string | null;
}

export async function prepareTerminalUpload(
  asset: TerminalUploadAsset,
  destination: "attachments" | "cwd" = "cwd",
): Promise<UploadRequest & { uploadId: string }> {
  const bytes = await new File(asset.uri).bytes();
  if (bytes.byteLength === 0 || bytes.byteLength > SESSION_UPLOAD_MAX_BYTES) {
    throw new Error("Terminal uploads must be between 1 byte and 20 MiB.");
  }
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  const uploadId = Crypto.randomUUID();
  const sha256 = bytesToLowerHex(new Uint8Array(digest));
  const record: DurableUploadOutcome = {
    uploadId,
    name: asset.name,
    destination,
    totalBytes: bytes.byteLength,
    sha256,
    createdAt: Date.now(),
  };
  return {
    uploadId,
    name: asset.name,
    mimeType: asset.mimeType ?? "application/octet-stream",
    destination,
    totalBytes: bytes.byteLength,
    sha256,
    source: {
      size: bytes.byteLength,
      read: async (offset, length) => bytes.slice(offset, offset + length),
    },
    beforeFinalDispatch: () => reserveUploadOutcomeUnknown(record),
  };
}
