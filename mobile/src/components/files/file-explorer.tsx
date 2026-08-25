import { FlashList } from "@shopify/flash-list";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { FileBreadcrumbs } from "@/components/files/breadcrumbs";
import { fileErrorMessage } from "@/components/files/errors";
import { FileRow } from "@/components/files/file-row";
import { FileViewer } from "@/components/files/file-viewer";
import { NameDialog } from "@/components/files/name-dialog";
import { retainDirectoryPages } from "@/components/files/pagination";
import { breadcrumbParts, visibleEntries } from "@/components/files/paths";
import { hasHostFileStreams } from "@/components/files/stream-adapter";
import type { HostDirEntry } from "@/components/files/types";
import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { ActionSheet, type ActionSheetAction } from "@/components/ui/action-sheet";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import {
  createHostFolder,
  removeHostEntry,
  renameHostEntry,
  useHostDirectory,
  useHostHome,
} from "@/data/queries/files";
import { qk } from "@/data/queryKeys";
import { haptics } from "@/lib/haptics";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import type { HostTransport, TransportState } from "@/terminal/transport/types";
import { spacing, useTheme } from "@/theme";

type NameMode = { kind: "create" } | { kind: "rename"; entry: HostDirEntry } | null;

export interface FileExplorerProps {
  hostId: string;
  hostName: string;
  hostIdentityPublicKey: string;
  initialPath?: string;
  /** Leaves the explorer. It owns its own header, since the header's controls are its state. */
  onBack(): void;
}

/**
 * A host's files, under the one header a screen gets. The folder's own
 * controls — a new folder, whether dotfiles show — sit behind the header's
 * overflow rather than on a second bar: two rows of chrome each with a back
 * arrow read as two screens stacked, and the breadcrumbs already say where
 * you are and take you up.
 */
export function FileExplorer({
  hostId,
  hostName,
  hostIdentityPublicKey,
  initialPath,
  onBack,
}: FileExplorerProps) {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [transport, setTransport] = useState<HostTransport | null>(null);
  const [transportState, setTransportState] = useState<TransportState>("idle");
  const [path, setPath] = useState("");
  const [showDotfiles, setShowDotfiles] = useState(true);
  const [selected, setSelected] = useState<HostDirEntry | null>(null);
  const [actionEntry, setActionEntry] = useState<HostDirEntry | null>(null);
  const [nameMode, setNameMode] = useState<NameMode>(null);
  const [deleteEntry, setDeleteEntry] = useState<HostDirEntry | null>(null);
  const [folderActionsVisible, setFolderActionsVisible] = useState(false);
  const [operationPending, setOperationPending] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [transportGeneration, setTransportGeneration] = useState(0);
  const ready = transportState === "ready";
  const home = useHostHome(hostId, transport, ready);

  useEffect(() => {
    if (!home.data || path) return;
    const requested = initialPath?.startsWith(home.data.home_dir)
      ? initialPath
      : home.data.home_dir;
    setPath(requested ?? home.data.home_dir);
  }, [home.data, initialPath, path]);

  const listing = useHostDirectory(hostId, path, transport, ready && Boolean(home.data));
  const retained = useMemo(
    () => retainDirectoryPages(listing.data?.pages ?? []),
    [listing.data?.pages],
  );
  const entries = useMemo(
    () => visibleEntries(retained.entries, showDotfiles),
    [retained.entries, showDotfiles],
  );
  const files = useMemo(() => entries.filter((entry) => entry.kind === "file"), [entries]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: qk.hostFiles(hostId, path) });
  };

  const runMutation = async (
    work: () => Promise<unknown>,
    context: "write" | "rename" | "remove",
  ) => {
    setOperationPending(true);
    setOperationError(null);
    try {
      await work();
      haptics.success();
      setNameMode(null);
      setDeleteEntry(null);
      await refresh();
    } catch (error) {
      haptics.error();
      setOperationError(fileErrorMessage(error, context));
    } finally {
      setOperationPending(false);
    }
  };

  const openEntry = (entry: HostDirEntry) => {
    setOperationError(null);
    if (entry.is_dir) setPath(entry.path);
    else setSelected(entry);
  };

  const actions: ActionSheetAction[] = actionEntry
    ? [
        ...(!actionEntry.is_dir
          ? [{ id: "preview", label: "Preview", onPress: () => setSelected(actionEntry) }]
          : [{ id: "open", label: "Open folder", onPress: () => setPath(actionEntry.path) }]),
        {
          id: "copy",
          label: "Copy path",
          onPress: () => void Clipboard.setStringAsync(actionEntry.path),
        },
        {
          id: "rename",
          label: "Rename",
          onPress: () => setNameMode({ kind: "rename", entry: actionEntry }),
        },
        ...(!actionEntry.is_dir
          ? [
              {
                id: "download",
                label: "Download & Share…",
                disabled: !hasHostFileStreams(transport),
                detail: hasHostFileStreams(transport)
                  ? "Keep SPAWN D open until transfer finishes."
                  : "Requires the verified host stream bridge.",
                onPress: () => setSelected(actionEntry),
              },
            ]
          : []),
        {
          id: "delete",
          label: "Delete",
          destructive: true,
          onPress: () => setDeleteEntry(actionEntry),
        },
      ]
    : [];

  const browsing = ready && Boolean(home.data) && Boolean(path);
  const folderLabel =
    home.data && path ? breadcrumbParts(path, home.data.home_dir).at(-1)?.label : undefined;
  const folderActions: ActionSheetAction[] = [
    {
      id: "create-folder",
      label: "New folder",
      icon: <Icon color="mutedForeground" name="FolderPlus" />,
      onPress: () => setNameMode({ kind: "create" }),
    },
    {
      id: "dotfiles",
      label: showDotfiles ? "Hide dotfiles" : "Show dotfiles",
      icon: <Icon color="mutedForeground" name={showDotfiles ? "EyeOff" : "Eye"} />,
      onPress: () => setShowDotfiles((value) => !value),
    },
  ];

  const header = (
    <AppHeader
      actions={[
        {
          accessibilityLabel: "Folder actions",
          disabled: !browsing,
          icon: "Ellipsis",
          onPress: () => setFolderActionsVisible(true),
        },
      ]}
      onBack={onBack}
      subtitle={hostName}
      title="Files"
    />
  );

  if (transportState === "failed") {
    return (
      <Screen header={header} padded={false}>
        <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
          <EmptyState
            action={
              <Button
                onPress={() => {
                  setTransport(null);
                  setTransportState("idle");
                  setTransportGeneration((generation) => generation + 1);
                }}
                variant="outline"
              >
                Retry
              </Button>
            }
            description="The direct host connection could not be established."
            icon="Unplug"
            title="Files unavailable"
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen header={header} padded={false}>
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <HostTransportSurface
          hostId={hostId}
          hostIdentityPublicKey={hostIdentityPublicKey}
          key={`${hostId}:${transportGeneration}`}
          onStateChange={setTransportState}
          onTransport={setTransport}
        />
        {home.data && path ? (
          <FileBreadcrumbs homeDir={home.data.home_dir} onNavigate={setPath} path={path} />
        ) : null}
        {operationError ? (
          <View style={[styles.notice, { backgroundColor: theme.colors.destructiveSoft }]}>
            <Icon color="destructive" name="AlertCircle" />
            <Text color="destructive" style={styles.noticeText}>
              {operationError}
            </Text>
          </View>
        ) : null}
        {!ready || home.isLoading ? (
          <View style={styles.center}>
            <Spinner label="Connecting to host files" size={spacing[6]} />
            <Text color="mutedForeground">Opening a private connection to {hostName}…</Text>
          </View>
        ) : listing.isError ? (
          <EmptyState
            action={
              <Button onPress={() => void listing.refetch()} variant="outline">
                Try again
              </Button>
            }
            description={fileErrorMessage(listing.error, "list")}
            icon="FolderSearch"
            title="Could not open this folder"
          />
        ) : listing.isLoading ? (
          <View style={styles.center}>
            <Spinner label="Loading folder" size={spacing[6]} />
          </View>
        ) : entries.length === 0 ? (
          <EmptyState
            description={
              showDotfiles ? "This folder is empty." : "No visible files. Dotfiles are hidden."
            }
            icon="FolderOpen"
            title="Nothing here"
          />
        ) : (
          <FlashList
            data={entries}
            keyExtractor={(entry) => entry.path}
            refreshControl={
              <RefreshControl
                onRefresh={() => void refresh()}
                refreshing={listing.isRefetching}
                tintColor={theme.colors.mutedForeground}
              />
            }
            renderItem={({ item }) => (
              <FileRow entry={item} onActions={setActionEntry} onOpen={openEntry} />
            )}
            ListFooterComponent={
              listing.hasNextPage ? (
                <View style={styles.loadMore}>
                  <Button
                    loading={listing.isFetchingNextPage}
                    onPress={() => void listing.fetchNextPage()}
                    variant="outline"
                  >
                    Load more
                  </Button>
                </View>
              ) : retained.limitReached ? (
                <Text color="mutedForeground" style={styles.limit} variant="caption">
                  This directory is truncated at the host scan limit.
                </Text>
              ) : null
            }
          />
        )}
        <ActionSheet
          actions={folderActions}
          onDismiss={() => setFolderActionsVisible(false)}
          {...(folderLabel === undefined ? {} : { title: folderLabel })}
          visible={folderActionsVisible}
        />
        <ActionSheet
          actions={actions}
          onDismiss={() => setActionEntry(null)}
          {...(actionEntry ? { title: actionEntry.name } : {})}
          visible={actionEntry !== null}
        />
        <NameDialog
          confirmLabel={nameMode?.kind === "rename" ? "Rename" : "Create folder"}
          initialValue={nameMode?.kind === "rename" ? nameMode.entry.name : ""}
          onConfirm={(name) => {
            if (!transport || !nameMode) return;
            void runMutation(
              () =>
                nameMode.kind === "create"
                  ? createHostFolder(transport, path, name)
                  : renameHostEntry(transport, nameMode.entry.path, name),
              nameMode.kind === "create" ? "write" : "rename",
            );
          }}
          onDismiss={() => setNameMode(null)}
          pending={operationPending}
          title={nameMode?.kind === "rename" ? "Rename item" : "New folder"}
          visible={nameMode !== null}
        />
        <Confirm
          cancelLabel="Cancel"
          confirmLabel="Delete"
          description={
            deleteEntry?.is_dir
              ? "This deletes the folder and everything inside it."
              : "This action cannot be undone."
          }
          destructive
          onCancel={() => setDeleteEntry(null)}
          onConfirm={() => {
            if (transport && deleteEntry)
              void runMutation(
                () => removeHostEntry(transport, deleteEntry.path, deleteEntry.is_dir),
                "remove",
              );
          }}
          title={`Delete ${deleteEntry?.name ?? "item"}?`}
          visible={deleteEntry !== null}
        />
        <FileViewer
          entry={selected}
          onDismiss={() => setSelected(null)}
          {...(selected && files.indexOf(selected) < files.length - 1
            ? { onNext: () => setSelected(files[files.indexOf(selected) + 1] ?? null) }
            : {})}
          {...(selected && files.indexOf(selected) > 0
            ? { onPrevious: () => setSelected(files[files.indexOf(selected) - 1] ?? null) }
            : {})}
          transport={transport}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: "center",
    flex: 1,
    gap: spacing[3],
    justifyContent: "center",
    padding: spacing[6],
  },
  limit: { padding: spacing[4], textAlign: "center" },
  loadMore: { alignItems: "center", padding: spacing[4] },
  notice: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  noticeText: { flex: 1 },
  root: { flex: 1 },
});
