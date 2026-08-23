import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  classifyFile,
  isTextKind,
  PREVIEW_BUDGET,
  previewBudgetDecision,
} from "@/components/files/file-kinds";
import { FileViewerBody, type ViewerState } from "@/components/files/file-viewer-body";
import { formatFileSize, formatModifiedTime } from "@/components/files/format";
import { createLocalDownload, shareLocalFile } from "@/components/files/local-file";
import {
  hasHostFileStreams,
  readableStreamFrames,
  readDeclaration,
} from "@/components/files/stream-adapter";
import { decodeText, looksBinary } from "@/components/files/text-decode";
import { receiveVerifiedHostFile } from "@/components/files/transfer";
import type { HostDirEntry } from "@/components/files/types";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import type { HostTransport } from "@/terminal/transport/types";
import { borderWidth, spacing, useTheme } from "@/theme";

const TRANSFER_KEEP_AWAKE_TAG = "spawn-host-file-transfer";

export interface FileViewerProps {
  entry: HostDirEntry | null;
  transport: HostTransport | null;
  onDismiss: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}

export function FileViewer({ entry, transport, onDismiss, onPrevious, onNext }: FileViewerProps) {
  const theme = useTheme();
  const [state, setState] = useState<ViewerState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const type = useMemo(() => (entry ? classifyFile(entry) : null), [entry]);

  useEffect(() => {
    if (state.status !== "loading") return;
    void activateKeepAwakeAsync(TRANSFER_KEEP_AWAKE_TAG);
    return () => {
      void deactivateKeepAwake(TRANSFER_KEEP_AWAKE_TAG);
    };
  }, [state.status]);

  const load = useCallback(async () => {
    if (!entry || !type || type.kind === "none") return;
    if (!hasHostFileStreams(transport)) {
      setState({
        status: "error",
        message: "Preview is unavailable while this host connection is in basic control mode.",
      });
      return;
    }
    const decision = previewBudgetDecision(entry.size, type);
    if (decision === "blocked") {
      setState({
        status: "error",
        message: `This ${type.label.toLowerCase()} is too large to preview.`,
      });
      return;
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setState({ status: "loading", received: 0, total: entry.size ?? 0 });
    try {
      if (isTextKind(type.kind)) {
        const head = await transport.readHead(entry.path, PREVIEW_BUDGET.textDecode, {
          signal: controller.signal,
          ...(entry.size === undefined ? {} : { size: entry.size }),
        });
        if (looksBinary(head.bytes))
          throw new Error("This file contains binary data and cannot be shown as text.");
        const decoded = decodeText(head.bytes, {
          partial: head.truncated,
          maxBytes: PREVIEW_BUDGET.textDecode,
          maxLines: 5000,
        });
        setState({
          status: "ready",
          content: {
            kind: "text",
            source: decoded.text,
            truncated: decoded.truncated || head.truncated,
          },
        });
        return;
      }
      const read =
        type.kind === "quicklook"
          ? await transport.previewImage(entry.path, PREVIEW_BUDGET.thumbPx.modal, {
              signal: controller.signal,
            })
          : await transport.readFile(entry.path, { signal: controller.signal });
      const local = createLocalDownload(read.name);
      await receiveVerifiedHostFile({
        declaration: readDeclaration(read),
        frames: readableStreamFrames(read),
        sink: local.sink,
        signal: controller.signal,
        onProgress: (received, total) => setState({ status: "loading", received, total }),
      });
      setState({ status: "ready", content: { kind: "file", uri: local.file.uri } });
    } catch (error) {
      if (!controller.signal.aborted) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Could not preview this file.",
        });
      }
    }
  }, [entry, transport, type]);

  useEffect(() => {
    abortRef.current?.abort();
    if (!entry || !type || type.kind === "none") setState({ status: "idle" });
    else
      setState({ status: previewBudgetDecision(entry.size, type) === "auto" ? "idle" : "confirm" });
    if (
      entry &&
      type &&
      type.kind !== "none" &&
      previewBudgetDecision(entry.size, type) === "auto"
    ) {
      void load();
    }
    return () => abortRef.current?.abort();
  }, [entry, load, type]);

  const downloadAndShare = async () => {
    if (!entry || !hasHostFileStreams(transport)) return;
    const previousState = state;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const read = await transport.readFile(entry.path, { signal: controller.signal });
      const local = createLocalDownload(read.name);
      setState({ status: "loading", received: 0, total: read.length });
      await receiveVerifiedHostFile({
        declaration: readDeclaration(read),
        frames: readableStreamFrames(read),
        sink: local.sink,
        signal: controller.signal,
        onProgress: (received, total) => setState({ status: "loading", received, total }),
      });
      await shareLocalFile(local.file);
      setState(previousState.status === "ready" ? previousState : { status: "idle" });
    } catch (error) {
      if (!controller.signal.aborted)
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Download failed.",
        });
    }
  };

  if (!entry || !type) return null;
  return (
    <Dialog
      closeAccessibilityLabel="Close file viewer"
      contentStyle={styles.dialog}
      onDismiss={() => {
        abortRef.current?.abort();
        onDismiss();
      }}
      size="viewer"
      visible
    >
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <View style={styles.headerCopy}>
          <Text numberOfLines={1} variant="label" weight="semibold">
            {entry.name}
          </Text>
          <Text color="mutedForeground" numberOfLines={1} variant="caption">
            {type.label} · {formatFileSize(entry.size)}
          </Text>
        </View>
        <IconButton
          accessibilityLabel="Previous file"
          disabled={!onPrevious}
          icon="ChevronLeft"
          onPress={onPrevious}
          size="sm"
        />
        <IconButton
          accessibilityLabel="Next file"
          disabled={!onNext}
          icon="ChevronRight"
          onPress={onNext}
          size="sm"
        />
      </View>
      <View style={styles.body}>
        <FileViewerBody
          entry={entry}
          onCancel={() => {
            abortRef.current?.abort();
            setState({ status: "error", message: "Preview cancelled." });
          }}
          onLoad={load}
          state={state}
          type={type}
        />
      </View>
      <View style={[styles.footer, { borderTopColor: theme.colors.border }]}>
        <View style={styles.footerCopy}>
          <Text color="mutedForeground" numberOfLines={1} variant="caption">
            {entry.path}
          </Text>
          <Text color="mutedForeground" variant="caption">
            {formatModifiedTime(entry.modified_at)}
          </Text>
        </View>
        <Button
          disabled={!hasHostFileStreams(transport) || entry.kind !== "file"}
          onPress={() => void downloadAndShare()}
          size="sm"
          variant="outline"
        >
          Download & Share…
        </Button>
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  dialog: { flex: 1 },
  footer: {
    alignItems: "center",
    borderTopWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: spacing[3],
    padding: spacing[3],
  },
  footerCopy: { flex: 1, minWidth: 0 },
  header: {
    alignItems: "center",
    borderBottomWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: spacing[1],
    paddingBottom: spacing[3],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[12],
  },
  headerCopy: { flex: 1, minWidth: 0 },
});
