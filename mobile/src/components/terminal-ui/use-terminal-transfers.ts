import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { useState } from "react";
import { Alert } from "react-native";

import {
  LARGE_PASTE_CONFIRM_BYTES,
  MAX_INTERACTIVE_PASTE_BYTES,
  writeTerminalInput,
} from "@/components/terminal-ui/terminal-input";
import { clearUploadOutcome, prepareTerminalUpload } from "@/components/terminal-ui/upload-file";
import { haptics } from "@/lib/haptics";
import type { SessionTransport, UploadProgress } from "@/terminal/transport/types";
import { type UploadTrack, uploadRatio } from "@/terminal/transport/upload";

function confirmLargePaste(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      "Paste large text?",
      "This paste is larger than 100 KiB and may take a moment to send.",
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Paste", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export interface TerminalTransfersOptions {
  transport: () => SessionTransport | null;
  ready: boolean;
  onInputSent: () => void;
}

export interface TerminalTransfers {
  notice: string | null;
  setNotice: (notice: string | null) => void;
  progressRatio: number | null;
  paste: () => Promise<void>;
  uploadFile: () => Promise<void>;
}

export function useTerminalTransfers({
  transport: getTransport,
  ready,
  onInputSent,
}: TerminalTransfersOptions): TerminalTransfers {
  const [notice, setNotice] = useState<string | null>(null);
  const [pasteRatio, setPasteRatio] = useState<number | null>(null);
  const [uploadTracks, setUploadTracks] = useState<Record<string, UploadTrack>>({});

  const paste = async (): Promise<void> => {
    const transport = getTransport();
    if (!transport || !ready) {
      haptics.warning();
      setNotice("Reconnect before pasting into this terminal.");
      return;
    }
    try {
      const value = await Clipboard.getStringAsync();
      const bytes = new TextEncoder().encode(value);
      if (bytes.byteLength === 0) {
        setNotice("The clipboard does not contain text.");
        return;
      }
      if (bytes.byteLength > MAX_INTERACTIVE_PASTE_BYTES) {
        setNotice("Pastes are limited to 1 MiB. Upload the content as a file instead.");
        haptics.warning();
        return;
      }
      if (bytes.byteLength > LARGE_PASTE_CONFIRM_BYTES && !(await confirmLargePaste())) return;
      setPasteRatio(0);
      await writeTerminalInput(transport, bytes, setPasteRatio);
      onInputSent();
      setPasteRatio(null);
    } catch (error) {
      setPasteRatio(null);
      setNotice(error instanceof Error ? error.message : "Clipboard paste failed.");
      haptics.error();
    }
  };

  const updateUploadTrack = (progress: UploadProgress): void => {
    setUploadTracks((tracks) => {
      if (
        progress.state === "complete" ||
        progress.state === "failed" ||
        progress.state === "cancelled"
      ) {
        const { [progress.uploadId]: _removed, ...rest } = tracks;
        return rest;
      }
      return {
        ...tracks,
        [progress.uploadId]: { sent: progress.sentBytes, total: progress.totalBytes },
      };
    });
  };

  const removeTrack = (uploadId: string): void => {
    setUploadTracks((tracks) => {
      const { [uploadId]: _removed, ...rest } = tracks;
      return rest;
    });
  };

  const uploadFile = async (): Promise<void> => {
    const transport = getTransport();
    if (!transport || !ready) {
      setNotice("Reconnect before uploading to this session.");
      haptics.warning();
      return;
    }
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        type: "*/*",
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      setNotice("Preparing upload…");
      const request = await prepareTerminalUpload(asset, "cwd");
      setUploadTracks((tracks) => ({
        ...tracks,
        [request.uploadId]: { sent: 0, total: request.totalBytes },
      }));
      const handle = transport.upload(request);
      const unsubscribe = handle.onProgress(updateUploadTrack);
      setNotice(`Uploading ${request.name}…`);
      try {
        const completed = await handle.result;
        await clearUploadOutcome(completed.uploadId);
        removeTrack(completed.uploadId);
        setNotice(`Uploaded ${request.name}.`);
        haptics.success();
      } catch (error) {
        if (handle.state !== "outcome_unknown") await clearUploadOutcome(handle.uploadId);
        removeTrack(handle.uploadId);
        setNotice(
          handle.state === "outcome_unknown"
            ? "Upload outcome is unknown. Check the destination before retrying."
            : error instanceof Error
              ? error.message
              : "Upload failed.",
        );
        haptics.error();
      } finally {
        unsubscribe();
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The file could not be prepared.");
      haptics.error();
    }
  };

  return {
    notice,
    setNotice,
    progressRatio: pasteRatio ?? uploadRatio(Object.values(uploadTracks)),
    paste,
    uploadFile,
  };
}
