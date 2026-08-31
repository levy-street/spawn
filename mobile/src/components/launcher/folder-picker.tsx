import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, View } from "react-native";
import {
  breadcrumbParts,
  folderErrorMessage,
  type HostDirEntry,
  type HostDirList,
  homeRoot,
  isWithinHome,
  joinDirectory,
  listAllEntries,
  normalizeAbsolutePath,
  normalizeCwdForHost,
  type PathFlavor,
  parentWithinHome,
  pathBasename,
  pathEquals,
  visibleDirectories,
} from "@/components/launcher/folder-picker-logic";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import type { RecentDirOut } from "@/data/api/schemas/hosts";
import { haptics } from "@/lib/haptics";
import type { HostTransport, TransportState } from "@/terminal/transport/types";
import { borderWidth, chrome, spacing, useTheme } from "@/theme";

const SHOW_HIDDEN_STORAGE_KEY = "spawn.folderPicker.showHidden";

export interface FolderPickerProps {
  transport: HostTransport | null;
  transportState: TransportState;
  hostName?: string;
  connectionError?: string | null;
  initialPath?: string | null;
  pathFlavor?: PathFlavor;
  recentError?: string | null;
  recentDirectories: readonly RecentDirOut[];
  onRetry?: () => void;
  onSelect(path: string): void;
}

export function FolderPicker({
  transport,
  transportState,
  hostName,
  connectionError,
  initialPath,
  pathFlavor = "posix",
  recentError,
  recentDirectories,
  onRetry,
  onSelect,
}: FolderPickerProps): React.JSX.Element {
  const theme = useTheme();
  const requestGeneration = useRef(0);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [typedPath, setTypedPath] = useState("");
  const [entries, setEntries] = useState<HostDirEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(SHOW_HIDDEN_STORAGE_KEY).then((value) => {
      if (active) setShowHidden(value === "true");
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!transport || transportState !== "ready") return;
    let active = true;
    setIsLoading(true);
    setError(null);
    void transport
      .request<{ home_dir: string }>("fs.home")
      .then(({ home_dir }) => {
        if (!active) return;
        const root = homeRoot(home_dir, pathFlavor);
        const nextPath = normalizeCwdForHost(initialPath ?? root, root, pathFlavor);
        setHomeDir(root);
        setCurrentPath(nextPath);
        setTypedPath(nextPath);
      })
      .catch((cause: unknown) => {
        if (active) setError(folderErrorMessage(cause));
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [initialPath, pathFlavor, transport, transportState]);

  const loadPath = useCallback(
    async (path: string) => {
      if (!transport || !homeDir || transportState !== "ready") return;
      const generation = requestGeneration.current + 1;
      requestGeneration.current = generation;
      setIsLoading(true);
      setError(null);
      try {
        const result = await listAllEntries((cursor) =>
          transport.request<HostDirList>("fs.list", { path, cursor }),
        );
        if (requestGeneration.current !== generation) return;
        setEntries(result.entries);
        setTruncated(result.truncated);
      } catch (cause) {
        if (requestGeneration.current !== generation) return;
        setEntries([]);
        setTruncated(false);
        setError(folderErrorMessage(cause));
      } finally {
        if (requestGeneration.current === generation) setIsLoading(false);
      }
    },
    [homeDir, transport, transportState],
  );

  useEffect(() => {
    if (currentPath && homeDir) void loadPath(currentPath);
  }, [currentPath, homeDir, loadPath]);

  const navigate = (path: string) => {
    if (!homeDir) return;
    const nextPath = normalizeAbsolutePath(path, pathFlavor);
    if (!isWithinHome(nextPath, homeDir, pathFlavor)) {
      setError(
        "That folder sits above your home folder, which is as far up as SPAWN D can browse.",
      );
      return;
    }
    haptics.selection();
    setFilter("");
    setError(null);
    setCurrentPath(nextPath);
    setTypedPath(nextPath);
  };

  const parent = homeDir ? parentWithinHome(currentPath, homeDir, pathFlavor) : null;
  const crumbs = homeDir ? breadcrumbParts(currentPath, homeDir, pathFlavor) : [];
  const visible = useMemo(
    () => visibleDirectories(entries, { filter, showHidden }),
    [entries, filter, showHidden],
  );
  const recentAtHome = Boolean(
    homeDir &&
      pathEquals(currentPath, homeDir, pathFlavor) &&
      filter.length === 0 &&
      recentDirectories.length > 0,
  );
  const canSelect = Boolean(homeDir && currentPath && !isLoading && !error);
  const connectionFailed = transportState === "failed" || transportState === "closed";
  const homeFailed = transportState === "ready" && !homeDir && error !== null;

  const retryConnection = useCallback(() => {
    requestGeneration.current += 1;
    setHomeDir(null);
    setCurrentPath("");
    setTypedPath("");
    setEntries([]);
    setTruncated(false);
    setIsLoading(false);
    setError(null);
    onRetry?.();
    if (!transport) return;
    // Failed transports are terminal until closed. The mounted surface keeps
    // its worker, so reopening this same transport is a real fresh attempt.
    transport.close();
    void transport.open().catch((cause: unknown) => setError(folderErrorMessage(cause)));
  }, [onRetry, transport]);

  if (connectionFailed || homeFailed) {
    return (
      <View accessibilityRole="alert" style={styles.centered}>
        <Icon color="destructive" name="Unplug" size={spacing[6]} />
        <Text style={styles.centeredText} variant="label">
          {`Couldn’t connect to ${hostName ?? "this host"}`}
        </Text>
        <Text color="mutedForeground" style={styles.centeredText} variant="caption">
          {connectionError ?? error ?? "The secure folder connection could not be established."}
        </Text>
        <Button disabled={!transport} onPress={retryConnection} size="sm" variant="outline">
          Retry
        </Button>
      </View>
    );
  }

  if (transportState !== "ready" || !homeDir) {
    return (
      <View style={styles.centered}>
        <Spinner label={`Connecting to ${hostName ?? "host"}`} size={spacing[6]} />
        <Text color="mutedForeground" variant="caption">
          {`Connecting to ${hostName ?? "host"}…`}
        </Text>
      </View>
    );
  }

  const emptyMessage = filter
    ? "No folders match this search."
    : entries.some((entry) => entry.is_dir && entry.name.startsWith(".")) && !showHidden
      ? "No visible folders. Hidden folders are available."
      : "No subfolders here.";

  return (
    <View style={styles.container}>
      <View style={styles.navigationRow}>
        <IconButton
          accessibilityLabel="Go to parent folder"
          disabled={!parent}
          icon="ChevronLeft"
          onPress={() => parent && navigate(parent)}
          size="sm"
        />
        <ScrollView
          contentContainerStyle={styles.crumbContent}
          horizontal
          showsHorizontalScrollIndicator={false}
        >
          {crumbs.map((crumb, index) => (
            <View key={crumb.path} style={styles.crumbGroup}>
              {index > 0 ? (
                <Icon color="mutedForeground" name="ChevronRight" size={spacing[3.5]} />
              ) : null}
              <Button onPress={() => navigate(crumb.path)} size="sm" variant="ghost">
                {crumb.label}
              </Button>
            </View>
          ))}
        </ScrollView>
      </View>

      <View style={styles.pathRow}>
        <Input
          accessibilityLabel="Folder path"
          containerStyle={styles.pathInput}
          onChangeText={setTypedPath}
          onSubmitEditing={() => navigate(typedPath)}
          placeholder={pathFlavor === "windows" ? "C:\\path\\to\\folder" : "/path/to/folder"}
          purpose="path"
          value={typedPath}
        />
        <Button onPress={() => navigate(typedPath)} size="sm" variant="outline">
          Go
        </Button>
      </View>

      <SearchField
        accessibilityLabel="Filter folders"
        onChangeText={setFilter}
        placeholder="Filter this folder"
        value={filter}
      />

      <View style={styles.hiddenRow}>
        <View style={styles.hiddenCopy}>
          <Text variant="label">Show hidden folders</Text>
          <Text color="mutedForeground" variant="caption">
            Include folders whose names begin with a dot.
          </Text>
        </View>
        <Switch
          accessibilityLabel="Show hidden folders"
          onValueChange={(next) => {
            setShowHidden(next);
            void AsyncStorage.setItem(SHOW_HIDDEN_STORAGE_KEY, String(next));
          }}
          value={showHidden}
        />
      </View>

      {recentAtHome ? (
        <View style={styles.recentSection}>
          <Text color="mutedForeground" variant="micro" weight="semibold">
            RECENT
          </Text>
          {recentDirectories.map((recent) => (
            <Pressable
              accessibilityLabel={`Open recent folder ${recent.path}`}
              accessibilityRole="button"
              key={recent.path}
              onPress={() => navigate(recent.path)}
              style={({ pressed }) => [
                styles.recentRow,
                {
                  backgroundColor: pressed ? theme.colors.accent : theme.colors.card,
                  borderColor: theme.colors.border,
                  borderRadius: theme.radii.md,
                },
              ]}
            >
              <Icon color="mutedForeground" name="Folder" size={spacing[4]} />
              <Text numberOfLines={1} style={styles.rowText} variant="label">
                {recent.path}
              </Text>
              <Icon color="mutedForeground" name="ChevronRight" size={spacing[4]} />
            </Pressable>
          ))}
        </View>
      ) : null}

      {homeDir && pathEquals(currentPath, homeDir, pathFlavor) && recentError ? (
        <Text color="warning" variant="caption">
          Recent folders are unavailable. You can still browse this host.
        </Text>
      ) : null}

      {error ? (
        <View style={[styles.message, { backgroundColor: theme.colors.destructiveSoft }]}>
          <Text color="destructive">{error}</Text>
          <Button onPress={() => void loadPath(currentPath)} size="sm" variant="ghost">
            Try again
          </Button>
        </View>
      ) : (
        <FlatList
          contentContainerStyle={visible.length === 0 ? styles.emptyList : undefined}
          data={visible}
          keyExtractor={(entry) => entry.path}
          ListEmptyComponent={
            isLoading ? (
              <Spinner size={spacing[6]} />
            ) : (
              <Text color="mutedForeground">{emptyMessage}</Text>
            )
          }
          renderItem={({ item }) => (
            <Pressable
              accessibilityLabel={`Open folder ${item.name}`}
              accessibilityRole="button"
              onPress={() => navigate(joinDirectory(currentPath, item.name, pathFlavor))}
              style={({ pressed }) => [
                styles.folderRow,
                {
                  backgroundColor: pressed ? theme.colors.accent : "transparent",
                  borderBottomColor: theme.colors.border,
                },
              ]}
            >
              <Icon color="mutedForeground" name="Folder" size={spacing[5]} />
              <Text numberOfLines={1} style={styles.rowText} variant="label">
                {item.name}
              </Text>
              <Icon color="mutedForeground" name="ChevronRight" size={spacing[4]} />
            </Pressable>
          )}
          style={styles.list}
        />
      )}

      {truncated ? (
        <Text color="warning" variant="caption">
          This folder is too large to show completely.
        </Text>
      ) : null}

      <Button disabled={!canSelect} onPress={() => onSelect(currentPath)}>
        {`Choose “${pathBasename(currentPath, pathFlavor)}”`}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: "center",
    flex: 1,
    gap: spacing[3],
    justifyContent: "center",
    padding: spacing[6],
  },
  centeredText: { textAlign: "center" },
  container: {
    flex: 1,
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[4],
  },
  navigationRow: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: chrome.touchTarget,
  },
  crumbContent: { alignItems: "center", paddingRight: spacing[4] },
  crumbGroup: { alignItems: "center", flexDirection: "row" },
  pathRow: { alignItems: "center", flexDirection: "row", gap: spacing[2] },
  pathInput: { flex: 1 },
  hiddenRow: { alignItems: "center", flexDirection: "row", gap: spacing[3] },
  hiddenCopy: { flex: 1 },
  recentSection: { gap: spacing[2] },
  recentRow: {
    alignItems: "center",
    borderWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: spacing[3],
    minHeight: chrome.touchTarget,
    paddingHorizontal: spacing[3],
  },
  message: { gap: spacing[2], padding: spacing[3] },
  list: { flex: 1 },
  emptyList: { alignItems: "center", flexGrow: 1, justifyContent: "center" },
  folderRow: {
    alignItems: "center",
    borderBottomWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: spacing[3],
    minHeight: chrome.touchTarget,
    paddingHorizontal: spacing[2],
  },
  rowText: { flex: 1 },
});
