import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { type ImageSource, pickImages } from "@/components/media/image-source";
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
import { duration } from "@/theme";

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

/**
 * A session takes any file, so its "files" source is not narrowed to images —
 * and it takes a queue of them, so every source that can offer several does.
 */
async function pickAttachments(source: AttachmentSource): Promise<TerminalUploadAsset[]> {
  return pickImages(source, { fileTypes: "*/*", multiple: true });
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
  const [notice, showNotice] = useState<string | null>(null);
  const [pasteRatio, setPasteRatio] = useState<number | null>(null);
  const [uploadTracks, setUploadTracks] = useState<Record<string, UploadTrack>>({});
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * A notice is a remark, not a state, so it retires itself. One that outstays
   * what it described — the "Uploading photo.jpg…" card that sat over the
   * output long after the file had landed — reads as an app that is stuck.
   */
  const setNotice = useCallback((message: string | null): void => {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    noticeTimer.current =
      message === null
        ? null
        : setTimeout(() => {
            noticeTimer.current = null;
            showNotice(null);
          }, duration.toastInfo);
    showNotice(message);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    },
    [],
  );

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

  /** Sends one picked file and answers with the path it landed on. */
  const sendOne = async (
    transport: SessionTransport,
    asset: TerminalUploadAsset,
    destination: "attachments" | "cwd",
  ): Promise<string> => {
    const request = await prepareTerminalUpload(asset, destination);
    setUploadTracks((tracks) => ({
      ...tracks,
      [request.uploadId]: { sent: 0, total: request.totalBytes },
    }));
    const handle = transport.upload(request);
    const unsubscribe = handle.onProgress(updateUploadTrack);
    try {
      const completed = await handle.result;
      await clearUploadOutcome(completed.uploadId);
      removeTrack(completed.uploadId);
      return completed.path;
    } catch (error) {
      if (handle.state !== "outcome_unknown") await clearUploadOutcome(handle.uploadId);
      removeTrack(handle.uploadId);
      throw handle.state === "outcome_unknown"
        ? new Error("Upload outcome is unknown. Check the destination before retrying.")
        : error;
    } finally {
      unsubscribe();
    }
  };

  const attach = async (source: AttachmentSource): Promise<void> => {
    const transport = getTransport();
    if (!transport || !ready) {
      setNotice("Reconnect before uploading to this session.");
      haptics.warning();
      return;
    }
    let assets: TerminalUploadAsset[];
    try {
      assets = await pickAttachments(source);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The file could not be prepared.");
      haptics.error();
      return;
    }
    if (assets.length === 0) return;

    // A photo is what the attachments destination exists for; an arbitrary
    // file belongs beside the work, in the session's directory.
    const destination = source === "files" ? "cwd" : "attachments";
    // One at a time: the bar reads them as a single sweep, and a phone on a
    // slow uplink does not fight itself over four sockets.
    const sent: string[] = [];
    const failures: string[] = [];
    setNotice(null);
    for (const asset of assets) {
      try {
        const path = await sendOne(transport, asset, destination);
        sent.push(path);
        if (destination === "attachments") {
          // An image is an input, not a saved file. Bracket-pasting its path at
          // the prompt is what a desktop terminal does when one is dragged onto
          // it, and what an agent reads as an attached image.
          const paste = new TextEncoder().encode(attachmentPasteSequence(path));
          await writeTerminalInput(transport, paste);
          onInputSent();
        }
      } catch (error) {
        failures.push(
          `${asset.name}: ${error instanceof Error ? error.message : "Upload failed."}`,
        );
      }
    }

    if (destination === "attachments" && sent.length > 0) onFocusTerminal();
    if (failures.length > 0) {
      // The first failure carries its own words; the rest are counted, since a
      // banner that lists five of them is a wall nobody reads.
      setNotice(
        failures.length === 1
          ? (failures[0] as string)
          : `${failures[0] as string} (and ${failures.length - 1} more failed)`,
      );
      haptics.error();
      return;
    }
    // The pasted paths land in the input, which says it better than a banner
    // repeating them does; only a file saved out of sight needs telling.
    if (destination === "cwd") {
      setNotice(
        sent.length === 1 ? `Uploaded to ${sent[0] as string}` : `Uploaded ${sent.length} files.`,
      );
    }
    haptics.success();
  };

  return {
    notice,
    setNotice,
    progressRatio: pasteRatio ?? uploadRatio(Object.values(uploadTracks)),
    paste,
    attach,
  };
}
