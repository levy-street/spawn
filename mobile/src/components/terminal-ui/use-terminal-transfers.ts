import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Alert } from "react-native";
import { type ImageSource, pickImage } from "@/components/media/image-source";
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

/** A session takes any file, so its "files" source is not narrowed to images. */
async function pickAttachment(source: AttachmentSource): Promise<TerminalUploadAsset | null> {
  return pickImage(source, { fileTypes: "*/*" });
}

export interface TerminalTransfersOptions {
  transport: () => SessionTransport | null;
  ready: boolean;
  onInputSent: () => void;
  /** Returns the caret to the terminal once an attachment lands at the prompt. */
  onFocusTerminal: () => void;
}

/** Where the bytes for an attachment come from. */
/** The app's three image sources; the terminal's "files" is widened to any file. */
export type AttachmentSource = ImageSource;

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
          // No notice: the pasted path lands in the input, which says it better
          // than a banner repeating it does.
          const paste = new TextEncoder().encode(attachmentPasteSequence(completed.path));
          await writeTerminalInput(transport, paste);
          onInputSent();
          onFocusTerminal();
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
