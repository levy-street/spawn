import { Image } from "expo-image";
import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import WebView from "react-native-webview";
import { CodePreview } from "@/components/files/code-preview";
import type { classifyFile } from "@/components/files/file-kinds";
import { formatFileSize } from "@/components/files/format";
import { MarkdownPreview } from "@/components/files/markdown-preview";
import type { HostDirEntry } from "@/components/files/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { spacing, useTheme } from "@/theme";

export type ViewerContent =
  | { kind: "text"; source: string; truncated: boolean }
  | { kind: "file"; uri: string };

export type ViewerState =
  | { status: "idle" | "confirm" }
  | { status: "loading"; received: number; total: number }
  | { status: "ready"; content: ViewerContent }
  | { status: "error"; message: string };

export interface FileViewerBodyProps {
  state: ViewerState;
  type: NonNullable<ReturnType<typeof classifyFile>>;
  entry: HostDirEntry;
  onLoad: () => Promise<void>;
  onCancel: () => void;
}

export function FileViewerBody({ state, type, entry, onLoad, onCancel }: FileViewerBodyProps) {
  const theme = useTheme();
  if (type.kind === "none") {
    return (
      <MetadataState
        detail={
          entry.kind === "symlink"
            ? "Spawn does not follow symbolic links."
            : "Inline preview is unavailable for this file type."
        }
        title={type.label}
      />
    );
  }
  if (state.status === "confirm") {
    return (
      <MetadataState
        action={<Button onPress={() => void onLoad()}>Load preview</Button>}
        detail="Large previews use the direct host connection."
        title={`Load ${formatFileSize(entry.size)} preview?`}
      />
    );
  }
  if (state.status === "loading") {
    const ratio = state.total > 0 ? Math.min(1, state.received / state.total) : 0;
    return (
      <View style={styles.center}>
        <Spinner label="Loading file" size={spacing[6]} />
        <Text color="mutedForeground">
          {formatFileSize(state.received)} of {formatFileSize(state.total)}
        </Text>
        <View style={[styles.progressTrack, { backgroundColor: theme.colors.muted }]}>
          <View
            style={[
              styles.progressFill,
              { backgroundColor: theme.colors.primary, width: `${ratio * 100}%` },
            ]}
          />
        </View>
        <Button onPress={onCancel} size="sm" variant="outline">
          Cancel
        </Button>
      </View>
    );
  }
  if (state.status === "error") {
    return (
      <MetadataState
        action={
          <Button onPress={() => void onLoad()} variant="outline">
            Try again
          </Button>
        }
        detail={state.message}
        title="Preview unavailable"
      />
    );
  }
  if (state.status !== "ready") {
    return <MetadataState detail="Preparing preview…" title={type.label} />;
  }
  if (state.content.kind === "text") {
    if (type.kind === "markdown") return <MarkdownPreview source={state.content.source} />;
    return (
      <View style={styles.textPreview}>
        <CodePreview language={type.language ?? "plain"} source={state.content.source} />
        {state.content.truncated ? (
          <Text color="mutedForeground" style={styles.truncated} variant="caption">
            Preview truncated at 1 MiB or 5,000 lines.
          </Text>
        ) : null}
      </View>
    );
  }
  if (type.kind === "image" || type.kind === "svg" || type.kind === "quicklook") {
    return (
      <Image
        accessibilityLabel={`Preview of ${entry.name}`}
        contentFit="contain"
        source={{ uri: state.content.uri }}
        style={styles.media}
      />
    );
  }
  if (type.kind === "pdf") {
    return (
      <WebView
        accessibilityLabel={`PDF preview of ${entry.name}`}
        allowFileAccess
        originWhitelist={["file://*"]}
        source={{ uri: state.content.uri }}
        style={styles.media}
      />
    );
  }
  return (
    <WebView
      accessibilityLabel={`${type.label} preview of ${entry.name}`}
      allowFileAccess
      mediaPlaybackRequiresUserAction
      originWhitelist={["file://*"]}
      source={{ uri: state.content.uri }}
      style={styles.media}
    />
  );
}

function MetadataState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <ScrollView contentContainerStyle={styles.center}>
      <Text variant="title">{title}</Text>
      <Text color="mutedForeground" style={styles.centerText}>
        {detail}
      </Text>
      {action}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: "center",
    flexGrow: 1,
    gap: spacing[3],
    justifyContent: "center",
    padding: spacing[6],
  },
  centerText: { maxWidth: spacing[32] * 2, textAlign: "center" },
  media: { flex: 1 },
  progressFill: { height: spacing[1] },
  progressTrack: {
    height: spacing[1],
    maxWidth: spacing[32] * 2,
    overflow: "hidden",
    width: "100%",
  },
  textPreview: { flex: 1 },
  truncated: { padding: spacing[3], textAlign: "center" },
});
