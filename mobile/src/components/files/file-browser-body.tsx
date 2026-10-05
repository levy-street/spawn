import { useIsFocused } from "@react-navigation/native";
import { FlashList } from "@shopify/flash-list";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, RefreshControl, StyleSheet, View } from "react-native";
import { FileBreadcrumbs } from "@/components/files/breadcrumbs";
import {
  changedOnHostNotice,
  DELETE_PERMANENTLY,
  DELETE_PERMANENTLY_MENU,
  deleteConfirmDescription,
  deleteConfirmTitle,
  deletedNotice,
  deletingNotice,
  emptyFolderDescription,
  FILTER_PLACEHOLDER,
  folderCountLabel,
  HIDE_HIDDEN_LABEL,
  noMatchesDescription,
  partialDeleteMessage,
  SHOW_HIDDEN_LABEL,
  selectionCountLabel,
  truncatedFolderNotice,
} from "@/components/files/copy";
import {
  type FileErrorContext,
  fileErrorCode,
  fileErrorMessage,
  listErrorCopy,
} from "@/components/files/errors";
import { FileRow } from "@/components/files/file-row";
import { FileViewer } from "@/components/files/file-viewer";
import { FilesOpenHere, type OpenedWindow } from "@/components/files/files-open-here";
import { countHiddenMatches, filterEntries } from "@/components/files/filter";
import { GoToFolderDialog } from "@/components/files/go-to-folder-dialog";
import { NameDialog } from "@/components/files/name-dialog";
import {
  breadcrumbParts,
  displayPath,
  homeRoot,
  isWithinHome,
  parentWithinHome,
  pathEquals,
  pathFlavorForHostOS,
  resolveLinkedFolder,
} from "@/components/files/paths";
import {
  allShownSelected,
  EMPTY_SELECTION,
  type FileSelection,
  retainShown,
  selectAllShown,
  selectedEntries,
  toggleSelected,
} from "@/components/files/selection";
import { SelectionBar } from "@/components/files/selection-bar";
import { SendToHostSheet } from "@/components/files/send-to-host-sheet";
import { sortEntries } from "@/components/files/sort";
import { hasHostFileStreams } from "@/components/files/stream-adapter";
import { HOST_TRANSFER_MAX_BYTES } from "@/components/files/transfer";
import {
  DOWNLOAD_AND_SHARE,
  FOLDER_DOWNLOAD_UNAVAILABLE,
  KEEP_OPEN,
  OPEN_TERMINAL_HERE,
  proceedAnywayLabel,
  relayWarning,
  SEND_TO_ANOTHER_HOST,
  START_AGENT_HERE,
  tooLargeFile,
  UPLOAD_FROM_FILES,
  UPLOAD_FROM_PHOTOS,
} from "@/components/files/transfer-copy";
import {
  type ConflictDecision,
  estimateSeconds,
  expectedRate,
  needsRelayWarning,
  relayedHosts,
  worthEstimating,
} from "@/components/files/transfer-plan";
import { TransfersBanner } from "@/components/files/transfers-banner";
import type { HostDirEntry } from "@/components/files/types";
import { UploadConflictSheet } from "@/components/files/upload-conflict-sheet";
import { releaseLocalCopy } from "@/components/files/upload-source";
import { ViewOptionsSheet } from "@/components/files/view-options-sheet";
import type { OpenHereRequest } from "@/components/launcher/open-here-sheet";
import { type PickedOriginal, pickOriginalFiles } from "@/components/media/image-source";
import { ActionSheet, type ActionSheetAction } from "@/components/ui/action-sheet";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon, type IconName } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { SearchField } from "@/components/ui/search-field";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import {
  canCreateHostFile,
  createHostFile,
  createHostFolder,
  fetchHostDirectoryPage,
  hostCan,
  isFinalListError,
  removeHostEntries,
  renameHostEntry,
  useHostHome,
  useHostListing,
  useHostListingPoll,
} from "@/data/queries/files";
import { qk } from "@/data/queryKeys";
import { useFileViewOptions } from "@/data/stores/explorer-prefs";
import { type NewTransferItem, useTransfersStore } from "@/data/stores/transfers";
import { useAppActive } from "@/lib/app-active";
import { haptics } from "@/lib/haptics";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import { HOST_CONSUMER_LIMIT_CODE } from "@/terminal/transport/host-ctl-codec";
import type { HostTransport, TransportError, TransportState } from "@/terminal/transport/types";
import { spacing, useTheme } from "@/theme";

/** Where the body asks to go. `ancestor` is a folder above this one: a breadcrumb, or Go to folder. */
export interface FolderNavigation {
  path: string;
  ancestor: boolean;
}

export interface FileBrowserBodyProps {
  hostId: string;
  hostName: string;
  hostIdentityPublicKey: string;
  hostOS?: string | null;
  /** The folder shown: a full path, `~`, `~/…`, or nothing for home. Clamped to home. */
  path?: string;
  /**
   * False while whatever embeds the body has it out of view — a tab not
   * showing. It holds a host channel only while it is the screen on top and
   * active, and polls only while the app is in front as well.
   */
  active?: boolean;
  /**
   * Shows another folder. The body never navigates itself: every folder is its
   * own screen, so the system's back gesture returns to the previous one.
   */
  onOpenFolder(navigation: FolderNavigation): void;
  /**
   * The folder actually shown, once known. A link to a file shows the folder
   * it is in, so whatever titles the body can name that folder.
   */
  onShowFolder?(folder: string): void;
  /**
   * Shows a window opened from a folder ("Open terminal here", "Start agent
   * here…"). Without it the browser does not offer to open one.
   */
  onWindowOpened?(opened: OpenedWindow): void;
}

type NameMode =
  | { kind: "folder" }
  | { kind: "file" }
  | { kind: "rename"; entry: HostDirEntry }
  | null;

/** A link that named a file rather than a folder. */
interface LinkedFile {
  /** The `path` it came in on. */
  link: string | undefined;
  /** The file, as the host spells it. */
  path: string;
  /** Opened over its folder already, so closing it stays closed. */
  opened: boolean;
}

/**
 * Files picked to upload into the folder, on their way to the queue: first a
 * relay warning if the upload is big and relayed (OD3), then one question for
 * each picked file whose name the folder already holds.
 */
interface UploadFlow {
  picked: PickedOriginal[];
  /** The host's name when this device reaches it through the relay. */
  relayed: string[];
  /** About how long it will take, when that is worth saying (OD3). */
  estimate: number | null;
  total: number;
  step: "relay" | "conflicts";
  /** Picked files whose names are taken here, still to be answered. */
  clashes: (PickedOriginal & { clashIsDir: boolean })[];
  /** The answers so far, by the picked file's local address. */
  decisions: ReadonlyMap<string, ConflictDecision>;
}

/** A line about the folder as a whole: what a change did, or what one is doing. */
interface FolderStatus {
  message: string;
  tone: "muted" | "destructive";
  /** Something is under way; it cannot be stopped, so nothing offers to. */
  busy?: boolean;
}

const NO_ENTRIES: readonly HostDirEntry[] = [];

/**
 * One folder on one host, without a screen around it: the host files route
 * wears it under its header, and the host cockpit can embed it. Sorting,
 * filtering and selection are the device's; the folder's contents are the
 * host's, read over the host's own end-to-end channel.
 */
export function FileBrowserBody({
  hostId,
  hostName,
  hostIdentityPublicKey,
  hostOS,
  path,
  active = true,
  onOpenFolder,
  onShowFolder,
  onWindowOpened,
}: FileBrowserBodyProps) {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const focused = useIsFocused();
  const appActive = useAppActive();
  // A folder underneath another gives its channel back: a deep stack of
  // folders must not hold one consumer each against the host's limit.
  const holdsChannel = active && focused;
  const pathFlavor = pathFlavorForHostOS(hostOS);
  const viewOptions = useFileViewOptions();
  const { sort, foldersFirst, showHidden } = viewOptions;

  const [transport, setTransport] = useState<HostTransport | null>(null);
  const [transportState, setTransportState] = useState<TransportState>("idle");
  const [transportError, setTransportError] = useState<TransportError | null>(null);
  const [transportGeneration, setTransportGeneration] = useState(0);

  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<FileSelection>(EMPTY_SELECTION);
  const [preview, setPreview] = useState<HostDirEntry | null>(null);
  const [actionEntry, setActionEntry] = useState<HostDirEntry | null>(null);
  const [folderActionsVisible, setFolderActionsVisible] = useState(false);
  const [viewOptionsVisible, setViewOptionsVisible] = useState(false);
  const [nameMode, setNameMode] = useState<NameMode>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<HostDirEntry[] | null>(null);
  const [goToVisible, setGoToVisible] = useState(false);
  const [goToError, setGoToError] = useState<string | null>(null);
  const [goToPending, setGoToPending] = useState(false);
  const [operationPending, setOperationPending] = useState(false);
  const [status, setStatus] = useState<FolderStatus | null>(null);
  const [manualRefresh, setManualRefresh] = useState(false);
  /** A linked path the host said is a file: its folder is shown, with it open. */
  const [linkedFileState, setLinkedFile] = useState<LinkedFile | null>(null);
  const [sendTargets, setSendTargets] = useState<readonly HostDirEntry[] | null>(null);
  const [openHere, setOpenHere] = useState<OpenHereRequest | null>(null);
  // The sheets that read the server are mounted once first asked for, not per folder screen.
  const [sendUsed, setSendUsed] = useState(false);
  const [openHereUsed, setOpenHereUsed] = useState(false);
  const [upload, setUpload] = useState<UploadFlow | null>(null);
  const enqueueTransfer = useTransfersStore((state) => state.enqueue);
  // Only for the link it was found on: a body shown another path starts afresh.
  const linkedFile = linkedFileState?.link === path ? linkedFileState : null;
  // Set before the first await, so a second tap cannot start the same delete twice.
  const deleting = useRef(false);
  // The confirm plays its exit with the answer it was raised for; a tap on it
  // then must not delete the same items again once the first run is over.
  const confirmedTargets = useRef<readonly HostDirEntry[] | null>(null);

  /** Clears the last outcome, but never the line saying a delete is still running. */
  const clearStatus = useCallback(() => {
    setStatus((current) => (current?.busy ? current : null));
  }, []);

  useEffect(() => {
    if (holdsChannel) return;
    setTransport(null);
    setTransportState("idle");
    setTransportError(null);
  }, [holdsChannel]);

  const ready = holdsChannel && transport !== null && transportState === "ready";
  // Home is the same for every folder on a host, so a folder pushed over
  // another knows where it is before its own channel opens.
  const home = useHostHome(hostId, transport, ready);
  const homeDir = home.data?.home_dir ?? null;
  const linked = homeDir ? resolveLinkedFolder(path, homeDir, pathFlavor) : null;
  const folder =
    homeDir && linked
      ? linkedFile
        ? (parentWithinHome(linkedFile.path, homeDir, pathFlavor) ?? homeRoot(homeDir, pathFlavor))
        : linked.folder
      : "";
  const listing = useHostListing(hostId, folder, transport, ready && folder.length > 0);
  useHostListingPoll(hostId, folder, transport, ready && appActive && listing.isSuccess);
  const listingFailed = listing.isError && !listing.isFetching;
  // A folder that is gone or shut shows why, not the rows it used to have.
  const listingGone = listingFailed && isFinalListError(listing.error);
  // A link to a file: the host says it is not a folder, so its folder opens instead.
  const linkIsFile =
    linked !== null &&
    linkedFile === null &&
    listingFailed &&
    fileErrorCode(listing.error) === "not_directory" &&
    !pathEquals(linked.folder, homeRoot(homeDir ?? "", pathFlavor), pathFlavor);

  useEffect(() => {
    if (linkIsFile && linked) setLinkedFile({ link: path, path: linked.folder, opened: false });
  }, [linkIsFile, linked, path]);

  useEffect(() => {
    if (folder) onShowFolder?.(folder);
  }, [folder, onShowFolder]);

  // A full read cut off by the channel going is dropped, not kept as this
  // folder's error: the folder is read again when it comes back into view.
  useEffect(() => {
    if (ready || !folder) return;
    void queryClient.cancelQueries({ queryKey: qk.hostFiles(hostId, folder) });
  }, [folder, hostId, queryClient, ready]);

  const allEntries = listingGone ? NO_ENTRIES : (listing.data?.entries ?? NO_ENTRIES);
  const shown = useMemo(
    () => sortEntries(filterEntries(allEntries, { query, showHidden }), sort, foldersFirst),
    [allEntries, foldersFirst, query, showHidden, sort],
  );
  const hiddenKeptBack = useMemo(
    () => (showHidden ? 0 : countHiddenMatches(allEntries, query)),
    [allEntries, query, showHidden],
  );
  const files = useMemo(() => shown.filter((entry) => entry.kind === "file"), [shown]);

  useEffect(() => {
    setSelection((current) => retainShown(current, shown));
  }, [shown]);

  const exitSelection = useCallback(() => {
    setSelecting(false);
    setSelection(EMPTY_SELECTION);
  }, []);

  // A body shown a different folder in place starts that folder afresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the folder by design.
  useEffect(() => {
    setQuery("");
    exitSelection();
    setPreview(null);
    clearStatus();
  }, [clearStatus, exitSelection, folder]);

  // The linked file, open over its folder once the folder has been read.
  useEffect(() => {
    if (!linkedFile || linkedFile.opened || !listing.data) return;
    const target = listing.data.entries.find((entry) =>
      pathEquals(entry.path, linkedFile.path, pathFlavor),
    );
    setLinkedFile({ ...linkedFile, opened: true });
    if (target && !target.is_dir) setPreview(target);
  }, [linkedFile, listing.data, pathFlavor]);

  const startSelecting = useCallback(
    (entry?: HostDirEntry) => {
      clearStatus();
      setSelecting(true);
      setSelection(entry ? new Set([entry.path]) : EMPTY_SELECTION);
    },
    [clearStatus],
  );

  // Android's back leaves selection mode before it leaves the folder.
  useEffect(() => {
    if (!selecting || !holdsChannel) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      exitSelection();
      return true;
    });
    return () => subscription.remove();
  }, [exitSelection, holdsChannel, selecting]);

  const openEntry = useCallback(
    (entry: HostDirEntry) => {
      if (selecting) {
        setSelection((current) => toggleSelected(current, entry.path));
        return;
      }
      clearStatus();
      if (entry.is_dir) onOpenFolder({ path: entry.path, ancestor: false });
      else setPreview(entry);
    },
    [clearStatus, onOpenFolder, selecting],
  );

  const refreshListing = useCallback(
    () => queryClient.invalidateQueries({ queryKey: qk.hostFiles(hostId, folder) }),
    [folder, hostId, queryClient],
  );

  /**
   * New file, New folder and Rename. A refusal is said inside the dialog, where
   * the name was typed, and the dialog stays open for another try.
   */
  const runMutation = async (
    work: () => Promise<unknown>,
    context: FileErrorContext,
    names: { typed: string; current?: string },
  ) => {
    setOperationPending(true);
    setNameError(null);
    clearStatus();
    try {
      await work();
      haptics.success();
      setNameMode(null);
      await refreshListing();
    } catch (error) {
      haptics.error();
      const code = fileErrorCode(error);
      // A clash or a bad name is about the new name; anything else, the item's own.
      const aboutNewName =
        code === "already_exists" || code === "invalid_name" || code === "invalid_path";
      setNameError(
        fileErrorMessage(error, context, {
          host: hostName,
          name: aboutNewName ? names.typed : (names.current ?? names.typed),
        }),
      );
    } finally {
      setOperationPending(false);
    }
  };

  /**
   * The confirm closes on "Delete permanently", and the folder's notice line
   * says what is going while it goes. Nothing offers Cancel: the host removes
   * items one by one and there is no way to stop the rest yet.
   */
  const deleteConfirmed = async () => {
    const targets = deleteTargets;
    setDeleteTargets(null);
    if (!targets || targets.length === 0 || !transport || deleting.current) return;
    if (confirmedTargets.current === targets) return;
    confirmedTargets.current = targets;
    deleting.current = true;
    setOperationPending(true);
    setStatus({ busy: true, message: deletingNotice(targets, hostName), tone: "muted" });
    try {
      const result = await removeHostEntries(transport, targets);
      const firstFailure = result.failed[0];
      if (!firstFailure) {
        haptics.success();
        setStatus({
          message: deletedNotice(
            result.removed.map((entry) => entry.name),
            hostName,
          ),
          tone: "muted",
        });
        if (selecting) exitSelection();
      } else {
        haptics.error();
        const reason = fileErrorMessage(firstFailure.error, "remove", {
          host: hostName,
          name: firstFailure.entry.name,
        });
        setStatus({
          message:
            targets.length === 1
              ? reason
              : partialDeleteMessage(result.removed.length, targets.length, hostName, {
                  name: firstFailure.entry.name,
                  reason,
                }),
          tone: "destructive",
        });
        // What could not go stays picked, ready for another try.
        if (selecting) setSelection(new Set(result.failed.map(({ entry }) => entry.path)));
      }
    } finally {
      deleting.current = false;
      setOperationPending(false);
      await refreshListing();
    }
  };

  const goToFolder = async (target: string) => {
    if (!transport || !homeDir) return;
    if (pathEquals(target, folder, pathFlavor)) {
      setGoToVisible(false);
      return;
    }
    setGoToPending(true);
    setGoToError(null);
    try {
      // Asked of the host before going, so a typo is answered in the dialog
      // rather than by a screen that cannot open.
      await fetchHostDirectoryPage(transport, target, 0);
      setGoToVisible(false);
      onOpenFolder({
        path: target,
        ancestor: isWithinHome(folder, target, pathFlavor),
      });
    } catch (error) {
      setGoToError(fileErrorMessage(error, "goto", { host: hostName }));
    } finally {
      setGoToPending(false);
    }
  };

  const refreshNow = () => {
    if (!ready) return;
    setManualRefresh(true);
    void listing.refetch().finally(() => setManualRefresh(false));
  };

  const canCreateFolder = ready && hostCan(transport, "fs.mkdir");
  const canCreateFile = ready && canCreateHostFile(transport);
  const canRename = ready && hostCan(transport, "fs.rename");
  const canDelete = ready && hostCan(transport, "fs.remove");
  const canStream = hasHostFileStreams(transport);
  const canUpload = canCreateFile;
  // A send reads its files from here; the host it goes to is chosen, and asked, in its sheet.
  const canSend =
    ready && hostCan(transport, "fs.read") && typeof transport?.transferFileTo === "function";

  const folderLabel =
    homeDir && folder ? breadcrumbParts(folder, homeDir, pathFlavor).at(-1)?.label : undefined;
  const thisHost = {
    id: hostId,
    name: hostName,
    publicKey: hostIdentityPublicKey,
    os: hostOS ?? null,
  };

  /** Into the Transfers queue: every picked file, its answer to a taken name, or "ask" if none was needed. */
  const queueUpload = (flow: UploadFlow) => {
    setUpload(null);
    const items: NewTransferItem[] = [];
    const refused: { item: NewTransferItem; reason: string }[] = [];
    for (const file of flow.picked) {
      const item: NewTransferItem = {
        name: file.name,
        size: file.size,
        source: { kind: "local", uri: file.uri, mimeType: file.mimeType },
        policy: flow.decisions.get(file.uri) ?? "ask",
      };
      if (file.size !== null && file.size > HOST_TRANSFER_MAX_BYTES) {
        refused.push({ item, reason: tooLargeFile(file.name) });
      } else {
        items.push(item);
      }
    }
    enqueueTransfer({
      kind: "upload",
      source: null,
      destination: thisHost,
      destDir: folder,
      destLabel: folderLabel ?? hostName,
      items,
      refused,
    });
  };

  const continueUpload = (flow: UploadFlow) => {
    if (flow.step === "conflicts" && flow.clashes.length === 0) queueUpload(flow);
    else setUpload(flow);
  };

  /** Backing out uploads nothing, and the picker's copies go. */
  const abandonUpload = () => {
    for (const file of upload?.picked ?? []) releaseLocalCopy(file.uri);
    setUpload(null);
  };

  const startUpload = async (from: "files" | "photos") => {
    if (!transport || !folder) return;
    clearStatus();
    let picked: PickedOriginal[];
    try {
      picked = await pickOriginalFiles(from);
    } catch (error) {
      haptics.error();
      setStatus({
        message:
          error instanceof Error && error.message.trim()
            ? error.message
            : "SPAWN D couldn't open the picker.",
        tone: "destructive",
      });
      return;
    }
    if (picked.length === 0) return;
    const total = picked.reduce((sum, file) => sum + (file.size ?? 0), 0);
    const relayed = relayedHosts([{ name: hostName, info: transport.connectionInfo }]);
    const seconds = estimateSeconds(
      total,
      expectedRate(
        [{ hostId, info: transport.connectionInfo }],
        useTransfersStore.getState().routeRates,
      ),
    );
    const fold = (name: string) => (pathFlavor === "windows" ? name.toLocaleLowerCase() : name);
    const here = new Map(
      (listing.data?.entries ?? []).map((entry) => [fold(entry.name), entry.is_dir === true]),
    );
    continueUpload({
      picked,
      relayed,
      estimate: worthEstimating(seconds) ? seconds : null,
      total,
      step: needsRelayWarning(total, relayed) ? "relay" : "conflicts",
      clashes: picked.flatMap((file) => {
        const clashIsDir = here.get(fold(file.name));
        return clashIsDir === undefined ? [] : [{ ...file, clashIsDir }];
      }),
      decisions: new Map(),
    });
  };

  const answerConflict = (policy: ConflictDecision, applyToRest: boolean) => {
    if (!upload) return;
    const [current, ...rest] = upload.clashes;
    if (!current) return;
    const decisions = new Map(upload.decisions);
    for (const file of applyToRest ? upload.clashes : [current]) decisions.set(file.uri, policy);
    continueUpload({ ...upload, clashes: applyToRest ? [] : rest, decisions });
  };

  const firstClash = upload?.step === "conflicts" ? upload.clashes[0] : undefined;
  const uploadAsked = firstClash
    ? { name: firstClash.name, isDir: false, clashIsDir: firstClash.clashIsDir }
    : null;

  const openHereAt = (cwd: string, run: "shell" | "agent") => {
    setOpenHereUsed(true);
    setOpenHere({ cwd, run });
  };

  const sendEntries = (targets: readonly HostDirEntry[]) => {
    if (targets.length === 0) return;
    setSendUsed(true);
    setSendTargets(targets);
  };
  const folderActions: ActionSheetAction[] = [
    {
      id: "new-folder",
      label: "New folder",
      icon: <Icon color="mutedForeground" name="FolderPlus" />,
      disabled: !canCreateFolder,
      onPress: () => setNameMode({ kind: "folder" }),
    },
    {
      id: "new-file",
      label: "New file",
      icon: <Icon color="mutedForeground" name="FileText" />,
      disabled: !canCreateFile,
      onPress: () => setNameMode({ kind: "file" }),
    },
    {
      id: "upload-files",
      label: UPLOAD_FROM_FILES,
      icon: <Icon color="mutedForeground" name="Upload" />,
      disabled: !canUpload || !folder,
      onPress: () => void startUpload("files"),
    },
    {
      id: "upload-photos",
      label: UPLOAD_FROM_PHOTOS,
      icon: <Icon color="mutedForeground" name="ImagePlus" />,
      disabled: !canUpload || !folder,
      onPress: () => void startUpload("photos"),
    },
    ...(onWindowOpened
      ? [
          {
            id: "open-shell",
            label: OPEN_TERMINAL_HERE,
            icon: <Icon color="mutedForeground" name="SquareTerminal" />,
            disabled: !folder,
            onPress: () => openHereAt(folder, "shell"),
          },
          {
            id: "start-agent",
            label: START_AGENT_HERE,
            icon: <Icon color="mutedForeground" name="Bot" />,
            disabled: !folder,
            onPress: () => openHereAt(folder, "agent"),
          },
        ]
      : []),
    {
      id: "go-to-folder",
      label: "Go to folder…",
      icon: <Icon color="mutedForeground" name="FolderSearch" />,
      disabled: !ready || !homeDir,
      onPress: () => {
        setGoToError(null);
        setGoToVisible(true);
      },
    },
    {
      id: "select",
      label: "Select",
      icon: <Icon color="mutedForeground" name="CheckCircle2" />,
      disabled: shown.length === 0,
      onPress: () => startSelecting(),
    },
    {
      id: "hidden",
      label: showHidden ? HIDE_HIDDEN_LABEL : SHOW_HIDDEN_LABEL,
      icon: <Icon color="mutedForeground" name={showHidden ? "EyeOff" : "Eye"} />,
      onPress: () => viewOptions.setShowHidden(!showHidden),
    },
    {
      id: "view-options",
      label: "View options…",
      icon: <Icon color="mutedForeground" name="Settings2" />,
      onPress: () => setViewOptionsVisible(true),
    },
  ];

  const entryActions: ActionSheetAction[] = actionEntry
    ? [
        actionEntry.is_dir
          ? {
              id: "open",
              label: "Open folder",
              onPress: () => onOpenFolder({ path: actionEntry.path, ancestor: false }),
            }
          : { id: "preview", label: "Preview", onPress: () => setPreview(actionEntry) },
        {
          id: "copy",
          label: "Copy path",
          onPress: () => void Clipboard.setStringAsync(actionEntry.path),
        },
        {
          id: "rename",
          label: "Rename",
          disabled: !canRename,
          onPress: () => setNameMode({ kind: "rename", entry: actionEntry }),
        },
        actionEntry.is_dir
          ? {
              id: "download",
              label: DOWNLOAD_AND_SHARE,
              disabled: true,
              detail: FOLDER_DOWNLOAD_UNAVAILABLE,
              onPress: () => undefined,
            }
          : {
              id: "download",
              label: DOWNLOAD_AND_SHARE,
              disabled: !canStream,
              detail: canStream ? KEEP_OPEN : "Requires the verified host stream bridge.",
              onPress: () => setPreview(actionEntry),
            },
        {
          id: "send",
          label: SEND_TO_ANOTHER_HOST,
          disabled: !canSend || actionEntry.kind === "symlink",
          onPress: () => sendEntries([actionEntry]),
        },
        ...(actionEntry.is_dir && onWindowOpened
          ? [
              {
                id: "open-shell",
                label: OPEN_TERMINAL_HERE,
                onPress: () => openHereAt(actionEntry.path, "shell"),
              },
              {
                id: "start-agent",
                label: START_AGENT_HERE,
                onPress: () => openHereAt(actionEntry.path, "agent"),
              },
            ]
          : []),
        { id: "select", label: "Select", onPress: () => startSelecting(actionEntry) },
        {
          id: "delete",
          label: DELETE_PERMANENTLY_MENU,
          destructive: true,
          disabled: !canDelete || operationPending,
          onPress: () => setDeleteTargets([actionEntry]),
        },
      ]
    : [];

  const chosen = useMemo(() => selectedEntries(selection, shown), [selection, shown]);
  const everythingSelected = allShownSelected(selection, shown);

  if (holdsChannel && transportState === "failed") {
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <EmptyState
          action={
            <Button
              onPress={() => {
                setTransport(null);
                setTransportState("idle");
                setTransportError(null);
                setTransportGeneration((generation) => generation + 1);
              }}
              variant="outline"
            >
              Retry
            </Button>
          }
          description={
            // Too many views is something the person can fix; say so.
            transportError?.code === HOST_CONSUMER_LIMIT_CODE
              ? transportError.message
              : "The direct host connection could not be established."
          }
          icon="Unplug"
          title="Files unavailable"
        />
      </View>
    );
  }

  const listingData = listing.data;

  let content: ReactNode;
  if (!homeDir) {
    content = home.isError ? (
      <EmptyState
        action={
          <Button disabled={!ready} onPress={() => void home.refetch()} variant="outline">
            Try again
          </Button>
        }
        description={fileErrorMessage(home.error, "list", { host: hostName })}
        icon="FolderSearch"
        title="Could not open this folder"
      />
    ) : (
      <View style={styles.center}>
        <Spinner label="Connecting to host files" size={spacing[6]} />
        <Text color="mutedForeground">Opening a private connection to {hostName}…</Text>
      </View>
    );
  } else if (!listingData || listingGone || linkIsFile) {
    content =
      listingFailed && !linkIsFile ? (
        <EmptyState
          action={
            <Button disabled={!ready} onPress={() => void listing.refetch()} variant="outline">
              Try again
            </Button>
          }
          description={fileErrorMessage(listing.error, "list", { host: hostName })}
          icon="FolderSearch"
          title="Could not open this folder"
        />
      ) : (
        // Home is known, so this host has been reached before: a folder's own
        // channel opening is part of loading it, not news.
        <View style={styles.center}>
          <Spinner label="Loading folder" size={spacing[6]} />
        </View>
      );
  } else if (shown.length === 0) {
    content = query.trim() ? (
      <EmptyState
        description={noMatchesDescription(query, hiddenKeptBack)}
        icon="FolderSearch"
        title="No matches"
      />
    ) : (
      <EmptyState
        action={
          hiddenKeptBack > 0 ? (
            <Button onPress={() => viewOptions.setShowHidden(true)} variant="outline">
              Show hidden files
            </Button>
          ) : undefined
        }
        description={emptyFolderDescription(showHidden, hiddenKeptBack)}
        icon="FolderOpen"
        title="Nothing here"
      />
    );
  } else {
    content = (
      <FlashList
        data={shown}
        extraData={selecting ? selection : null}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(entry) => entry.path}
        ListFooterComponent={
          <Text color="mutedForeground" style={styles.footer} variant="caption">
            {folderCountLabel(shown.length, hiddenKeptBack)}
          </Text>
        }
        refreshControl={
          <RefreshControl
            onRefresh={refreshNow}
            refreshing={manualRefresh}
            tintColor={theme.colors.mutedForeground}
          />
        }
        renderItem={({ item }) => (
          <FileRow
            entry={item}
            onActions={setActionEntry}
            onOpen={openEntry}
            onSelect={startSelecting}
            selected={selecting && selection.has(item.path)}
            selecting={selecting}
          />
        )}
        testID="file-list"
      />
    );
  }

  const listingProblem =
    listingData && listingFailed && !listingGone && !linkIsFile
      ? fileErrorMessage(listing.error, "list", { host: hostName })
      : null;

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      {holdsChannel ? (
        <HostTransportSurface
          hostId={hostId}
          hostIdentityPublicKey={hostIdentityPublicKey}
          key={`${hostId}:${transportGeneration}`}
          onError={setTransportError}
          onStateChange={setTransportState}
          onTransport={setTransport}
        />
      ) : null}
      {homeDir && folder ? (
        <FileBreadcrumbs
          homeDir={homeDir}
          onNavigate={(crumb) => {
            if (!pathEquals(crumb, folder, pathFlavor)) {
              onOpenFolder({ path: crumb, ancestor: true });
            }
          }}
          path={folder}
          pathFlavor={pathFlavor}
        />
      ) : null}
      <View style={[styles.toolbar, { gap: theme.space(2), paddingHorizontal: theme.space(3) }]}>
        {selecting ? (
          <>
            <Button onPress={exitSelection} size="sm" variant="ghost">
              Done
            </Button>
            <Text
              accessibilityLiveRegion="polite"
              numberOfLines={1}
              style={styles.selectionCount}
              variant="label"
            >
              {selectionCountLabel(chosen.length)}
            </Text>
            <Button
              disabled={shown.length === 0}
              onPress={() =>
                setSelection(everythingSelected ? EMPTY_SELECTION : selectAllShown(shown))
              }
              size="sm"
              variant="ghost"
            >
              {everythingSelected ? "Deselect all" : "Select all"}
            </Button>
          </>
        ) : (
          <>
            <SearchField
              accessibilityLabel={FILTER_PLACEHOLDER}
              containerStyle={styles.filter}
              onChangeText={setQuery}
              placeholder={FILTER_PLACEHOLDER}
              value={query}
            />
            <IconButton
              accessibilityLabel="Folder actions"
              disabled={!homeDir}
              icon="Ellipsis"
              onPress={() => setFolderActionsVisible(true)}
            />
          </>
        )}
      </View>
      {status ? (
        <FolderNotice
          busy={status.busy === true}
          icon={status.tone === "destructive" ? "AlertCircle" : "CheckCircle2"}
          message={status.message}
          tone={status.tone}
        />
      ) : listingProblem ? (
        <FolderNotice
          action={
            <Button disabled={!ready} onPress={refreshNow} size="sm" variant="ghost">
              Try again
            </Button>
          }
          icon="AlertCircle"
          message={listingProblem}
          tone="destructive"
        />
      ) : listingData?.changedOnHost ? (
        <FolderNotice
          action={
            <Button disabled={!ready} onPress={refreshNow} size="sm" variant="ghost">
              Refresh
            </Button>
          }
          icon="RefreshCw"
          message={changedOnHostNotice(hostName)}
        />
      ) : linked?.outsideHome ? (
        <FolderNotice icon="AlertCircle" message={listErrorCopy("outside_root", hostName) ?? ""} />
      ) : null}
      {listingData?.truncated && !listingGone ? (
        // Above the list whatever it shows, so an empty filter says what it searched.
        <FolderNotice icon="AlertCircle" message={truncatedFolderNotice(hostName)} />
      ) : null}
      <TransfersBanner />
      <View style={styles.content}>{content}</View>
      {selecting ? (
        <SelectionBar
          canDelete={canDelete}
          canSend={canSend}
          count={chosen.length}
          onDelete={() => {
            if (!operationPending) setDeleteTargets(chosen);
          }}
          onSend={() => sendEntries(chosen.filter((entry) => entry.kind !== "symlink"))}
          pending={operationPending}
        />
      ) : null}
      <ActionSheet
        actions={folderActions}
        onDismiss={() => setFolderActionsVisible(false)}
        {...(folderLabel === undefined ? {} : { title: folderLabel })}
        {...(homeDir && folder
          ? { message: `${hostName} · ${displayPath(folder, homeDir, pathFlavor)}` }
          : {})}
        visible={folderActionsVisible}
      />
      <ActionSheet
        actions={entryActions}
        onDismiss={() => setActionEntry(null)}
        {...(actionEntry ? { title: actionEntry.name } : {})}
        visible={actionEntry !== null}
      />
      <ViewOptionsSheet
        foldersFirst={foldersFirst}
        onDismiss={() => setViewOptionsVisible(false)}
        onFoldersFirstChange={(next) => viewOptions.setFoldersFirst(next)}
        onShowHiddenChange={(next) => viewOptions.setShowHidden(next)}
        onSortChange={(next) => viewOptions.setSort(next)}
        showHidden={showHidden}
        sort={sort}
        visible={viewOptionsVisible}
      />
      <NameDialog
        confirmLabel={
          nameMode?.kind === "rename"
            ? "Rename"
            : nameMode?.kind === "file"
              ? "Create file"
              : "Create folder"
        }
        error={nameError}
        initialValue={nameMode?.kind === "rename" ? nameMode.entry.name : ""}
        onConfirm={(name) => {
          if (!transport || !nameMode) return;
          // The folder on screen answers a name already taken before the host
          // is asked; the host's mkdir would answer an old folder as made.
          const held =
            listingData && !listingGone
              ? {
                  entries: listingData.entries,
                  complete: !listingData.truncated && !listingData.changedOnHost,
                }
              : null;
          void runMutation(
            () =>
              nameMode.kind === "folder"
                ? createHostFolder(transport, folder, name, pathFlavor, held)
                : nameMode.kind === "file"
                  ? createHostFile(transport, folder, name)
                  : renameHostEntry(transport, nameMode.entry, name, folder, pathFlavor, held),
            nameMode.kind === "rename" ? "rename" : "write",
            nameMode.kind === "rename"
              ? { typed: name, current: nameMode.entry.name }
              : { typed: name },
          );
        }}
        onDismiss={() => {
          setNameMode(null);
          setNameError(null);
        }}
        pathFlavor={pathFlavor}
        pending={operationPending}
        title={
          nameMode?.kind === "rename"
            ? "Rename item"
            : nameMode?.kind === "file"
              ? "New file"
              : "New folder"
        }
        visible={nameMode !== null}
      />
      {homeDir ? (
        <GoToFolderDialog
          cwd={folder}
          error={goToError}
          homeDir={homeDir}
          hostName={hostName}
          initialValue={folder ? displayPath(folder, homeDir, pathFlavor) : "~"}
          onDismiss={() => setGoToVisible(false)}
          onGo={(target) => void goToFolder(target)}
          pathFlavor={pathFlavor}
          pending={goToPending}
          visible={goToVisible}
        />
      ) : null}
      <Confirm
        cancelLabel="Cancel"
        confirmLabel={DELETE_PERMANENTLY}
        description={deleteConfirmDescription(deleteTargets ?? [], hostName)}
        destructive
        onCancel={() => setDeleteTargets(null)}
        onConfirm={() => void deleteConfirmed()}
        title={deleteConfirmTitle(deleteTargets ?? [])}
        visible={deleteTargets !== null}
      />
      {sendUsed && homeDir && folder ? (
        <SendToHostSheet
          entries={sendTargets ?? NO_ENTRIES}
          onDismiss={() => setSendTargets(null)}
          source={thisHost}
          sourceFolder={folder}
          sourceHomeDir={homeDir}
          sourceTransport={ready ? transport : null}
          visible={sendTargets !== null}
        />
      ) : null}
      {openHereUsed && onWindowOpened ? (
        <FilesOpenHere
          hostId={hostId}
          onDismiss={() => setOpenHere(null)}
          onOpened={onWindowOpened}
          request={openHere}
        />
      ) : null}
      <Confirm
        cancelLabel="Cancel"
        confirmLabel={proceedAnywayLabel("upload")}
        description={upload ? relayWarning(upload.relayed, upload.total, upload.estimate) : ""}
        onCancel={abandonUpload}
        onConfirm={() => {
          if (upload) continueUpload({ ...upload, step: "conflicts" });
        }}
        title="Upload through the SPAWN D relay?"
        visible={upload?.step === "relay"}
      />
      <UploadConflictSheet
        folderLabel={folderLabel ?? hostName}
        hostName={hostName}
        asked={uploadAsked}
        onCancel={abandonUpload}
        onChoose={answerConflict}
        others={Math.max(0, (upload?.clashes.length ?? 0) - 1)}
      />
      <FileViewer
        entry={preview}
        onDismiss={() => setPreview(null)}
        {...(preview && files.indexOf(preview) < files.length - 1
          ? { onNext: () => setPreview(files[files.indexOf(preview) + 1] ?? null) }
          : {})}
        {...(preview && files.indexOf(preview) > 0
          ? { onPrevious: () => setPreview(files[files.indexOf(preview) - 1] ?? null) }
          : {})}
        hostName={hostName}
        transport={transport}
      />
    </View>
  );
}

/** One line about the folder as a whole, above its rows: a refusal, a change, a limit. */
function FolderNotice({
  action,
  busy = false,
  icon,
  message,
  tone = "muted",
}: {
  action?: ReactNode;
  busy?: boolean;
  icon: IconName;
  message: string;
  tone?: "muted" | "destructive";
}) {
  const theme = useTheme();
  const color = tone === "destructive" ? "destructive" : "mutedForeground";
  return (
    <View
      style={[
        styles.notice,
        {
          backgroundColor:
            tone === "destructive" ? theme.colors.destructiveSoft : theme.colors.muted,
        },
      ]}
    >
      {busy ? <Spinner label={message} size={spacing[4]} /> : <Icon color={color} name={icon} />}
      <Text accessibilityLiveRegion="polite" color={color} style={styles.noticeText}>
        {message}
      </Text>
      {action}
    </View>
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
  content: { flex: 1 },
  filter: { flex: 1 },
  footer: { padding: spacing[4], textAlign: "center" },
  notice: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  noticeText: { flex: 1 },
  root: { flex: 1 },
  selectionCount: { flex: 1, textAlign: "center" },
  toolbar: {
    alignItems: "center",
    flexDirection: "row",
    paddingBottom: spacing[2],
  },
});
