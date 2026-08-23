import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Alert } from "react-native";
import { attachmentPasteSequence } from "@/components/terminal-ui/attachment-paste";
import {
  LARGE_PASTE_CONFIRM_BYTES,
  MAX_INTERACTIVE_PASTE_BYTES,
  writeTerminalInput,
} from "@/components/terminal-ui/terminal-input";
import {
  clearUploadOutcome,
  prepareTerminalUpload,
  type TerminalUploadAsset,
} from "@/components/terminal-ui/upload-file";
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

function imageAssetName(asset: ImagePicker.ImagePickerAsset, fallback: string): string {
  if (asset.fileName && asset.fileName.length > 0) return asset.fileName;
  const extension = asset.uri.split(".").pop();
  return extension && /^[A-Za-z0-9]{1,5}$/.test(extension)
    ? `${fallback}.${extension.toLowerCase()}`
    : fallback;
}

/**
 * Resolves one attachment, or null when the operator backed out. Permission is
 * asked for at the point of use rather than up front, so a refusal explains
 * itself against the thing that was just tapped.
 */
async function pickAttachment(source: AttachmentSource): Promise<TerminalUploadAsset | null> {
  if (source === "files") {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
      type: "*/*",
    });
    const asset = result.canceled ? undefined : result.assets[0];
    return asset ? { uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? null } : null;
  }

  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error("spawn needs camera access to take a photo.");
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.9,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    return asset
      ? {
          uri: asset.uri,
          name: imageAssetName(asset, "photo.jpg"),
          mimeType: asset.mimeType ?? "image/jpeg",
        }
      : null;
  }

  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error("spawn needs photo access to upload from your library.");
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.9,
    selectionLimit: 1,
  });
  const asset = result.canceled ? undefined : result.assets[0];
  return asset
    ? {
        uri: asset.uri,
        name: imageAssetName(asset, "image.jpg"),
        mimeType: asset.mimeType ?? "image/jpeg",
      }
    : null;
}

export interface TerminalTransfersOptions {
  transport: () => SessionTransport | null;
  ready: boolean;
  onInputSent: () => void;
  /** Returns the caret to the terminal once an attachment lands at the prompt. */
  onFocusTerminal: () => void;
}

/** Where the bytes for an attachment come from. */
export type AttachmentSource = "camera" | "photos" | "files";

export interface TerminalTransfers {
  notice: string | null;
  setNotice: (notice: string | null) => void;
  progressRatio: number | null;
  paste: () => Promise<void>;
  attach: (source: AttachmentSource) => Promise<void>;
}

export function useTerminalTransfers({
  transport: getTransport,
  ready,
  onInputSent,
  onFocusTerminal,
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

  const attach = async (source: AttachmentSource): Promise<void> => {
    const transport = getTransport();
    if (!transport || !ready) {
      setNotice("Reconnect before uploading to this session.");
      haptics.warning();
      return;
    }
    try {
      const asset = await pickAttachment(source);
      if (!asset) return;
      setNotice("Preparing upload…");
      // A photo is what the attachments destination exists for; an arbitrary
      // file belongs beside the work, in the session's directory.
      const request = await prepareTerminalUpload(
        asset,
        source === "files" ? "cwd" : "attachments",
      );
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
        if (source === "files") {
          // A plain file was saved beside the work; the path is the useful half.
          setNotice(`Uploaded to ${completed.path}`);
        } else {
          // An image is an input, not a saved file. Bracket-pasting its path at
          // the prompt is what a desktop terminal does when one is dragged onto
          // it, and what an agent reads as an attached image.
          const paste = new TextEncoder().encode(attachmentPasteSequence(completed.path));
          await writeTerminalInput(transport, paste);
          onInputSent();
          onFocusTerminal();
          setNotice("Image attached");
        }
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
    attach,
  };
}
