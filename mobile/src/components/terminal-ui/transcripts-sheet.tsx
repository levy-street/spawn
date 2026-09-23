import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { FileViewer } from "@/components/files/file-viewer";
import { formatFileSize, formatModifiedTime } from "@/components/files/format";
import { createLocalDownload, shareLocalFile } from "@/components/files/local-file";
import {
  hasHostFileStreams,
  readableStreamFrames,
  readDeclaration,
} from "@/components/files/stream-adapter";
import { receiveVerifiedHostFile } from "@/components/files/transfer";
import type { HostDirEntry } from "@/components/files/types";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow, ListSeparator } from "@/components/ui/list-row";
import { Sheet, SheetHeader, SheetScrollView } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useAgentTranscripts } from "@/data/queries/files";
import {
  type TranscriptNotice,
  transcriptEmptyState,
  transcriptQueryFor,
  transcriptRoleLabel,
  transcriptsNeedAnAgent,
  transcriptsUnavailable,
} from "@/data/selectors/agent-transcripts";
import type { AgentDef, Session } from "@/data/types/domain";
import { AGENT_TRANSCRIPTS_OP } from "@/terminal/transport/host-ctl-codec";
import type {
  AgentTranscriptFile,
  HostTransport,
  TransportState,
} from "@/terminal/transport/types";
import { spacing, useTheme } from "@/theme";

const TRANSFER_KEEP_AWAKE_TAG = "spawn-transcript-transfer";

export interface TranscriptsSheetProps {
  visible: boolean;
  session: Session;
  hostName: string;
  agents: readonly AgentDef[];
  /** A host consumer transport the owner mounts while the sheet is up
   *  (`HostTransportSurface`), and its state. Null before it exists. */
  transport: HostTransport | null;
  transportState: TransportState;
  onDismiss: () => void;
}

/**
 * The agent's own record of this window's conversation — the files the
 * harness writes on the host as it goes — located by the daemon and read here
 * like any other host file. Nothing in it crosses the server: the list comes
 * over the device's host channel and every byte of a transcript over the same
 * channel the file explorer uses (`docs/TRUST.md`).
 *
 * A row opens the file viewer; its trailing control downloads the file and
 * hands it to the share sheet, the way the viewer's own button does.
 */
export function TranscriptsSheet({
  visible,
  session,
  hostName,
  agents,
  transport,
  transportState,
  onDismiss,
}: TranscriptsSheetProps): React.JSX.Element {
  const theme = useTheme();
  const target = useMemo(() => transcriptQueryFor(session, agents), [session, agents]);
  const ready = transportState === "ready" && transport !== null;
  const supported = ready && transport.hasCapability?.(AGENT_TRANSCRIPTS_OP) === true;
  const report = useAgentTranscripts(
    session.id,
    transport,
    target?.query ?? null,
    visible && supported,
  );
  const [selected, setSelected] = useState<HostDirEntry | null>(null);
  const [transfer, setTransfer] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // A closed sheet forgets its viewer and any transfer in flight: the next
  // opening is a fresh look at whatever the agent has written since.
  useEffect(() => {
    if (visible) return;
    abortRef.current?.abort();
    setSelected(null);
    setTransfer(null);
  }, [visible]);

  useEffect(() => {
    if (transfer === null) return;
    void activateKeepAwakeAsync(TRANSFER_KEEP_AWAKE_TAG);
    return () => {
      void deactivateKeepAwake(TRANSFER_KEEP_AWAKE_TAG);
    };
  }, [transfer]);

  const share = async (file: AgentTranscriptFile): Promise<void> => {
    if (!hasHostFileStreams(transport)) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setTransfer(`Downloading ${file.name}…`);
    try {
      const read = await transport.readFile(file.path, { signal: controller.signal });
      const local = createLocalDownload(read.name);
      await receiveVerifiedHostFile({
        declaration: readDeclaration(read),
        frames: readableStreamFrames(read),
        sink: local.sink,
        signal: controller.signal,
        onProgress: (received, total) =>
          setTransfer(
            `Downloading ${file.name}… ${total > 0 ? Math.round((received / total) * 100) : 0}%`,
          ),
      });
      setTransfer(null);
      await shareLocalFile(local.file);
    } catch (error) {
      if (!controller.signal.aborted) {
        setTransfer(`${file.name}: ${error instanceof Error ? error.message : "Download failed."}`);
      }
    }
  };

  const transcripts = report.data?.transcripts ?? [];
  let notice: TranscriptNotice | null = null;
  let busy: string | null = null;
  if (!target) notice = transcriptsNeedAnAgent();
  else if (transportState === "failed") {
    notice = {
      title: `Can't reach ${hostName}`,
      body: "Transcripts are read from the host directly, so it has to be online and trusted from this phone.",
    };
  } else if (!ready) busy = `Connecting to ${hostName}…`;
  else if (!supported) notice = transcriptsUnavailable(hostName);
  else if (report.isPending) busy = "Looking for transcripts…";
  else if (report.error) {
    notice = {
      title: "Couldn't list transcripts",
      body: report.error instanceof Error ? report.error.message : "The host did not answer.",
    };
  } else if (report.data) {
    notice = transcriptEmptyState(report.data, target.agent.name, hostName);
  }

  const selectedIndex = selected ? transcripts.findIndex((f) => f.path === selected.path) : -1;

  return (
    <>
      <Sheet onDismiss={onDismiss} size="tall" visible={visible}>
        <SheetHeader title={target ? `${target.agent.name} transcript` : "Transcript"} />
        <SheetScrollView
          contentContainerStyle={{
            paddingBottom: theme.space(6),
            paddingHorizontal: theme.space(4),
          }}
        >
          <Text color="mutedForeground" style={{ paddingBottom: theme.space(3) }} variant="caption">
            The conversation as the agent wrote it on {hostName}. Read straight from the host; the
            server never sees it.
          </Text>
          {busy ? (
            <View style={[styles.busy, { gap: theme.space(2), paddingVertical: theme.space(8) }]}>
              <Spinner label={busy} size={spacing[6]} />
              <Text color="mutedForeground" variant="caption">
                {busy}
              </Text>
            </View>
          ) : notice ? (
            <EmptyState
              description={notice.body}
              icon={transportState === "failed" ? "Unplug" : "FileText"}
              title={notice.title}
            />
          ) : (
            <View
              style={{
                borderColor: theme.colors.border,
                borderRadius: theme.radii.lg,
                borderWidth: StyleSheet.hairlineWidth,
                overflow: "hidden",
              }}
            >
              {transcripts.map((file, index) => (
                <Fragment key={file.path}>
                  {index > 0 ? <ListSeparator /> : null}
                  <ListRow
                    onPress={() => setSelected(entryOf(file))}
                    shape="fullBleed"
                    subtitle={`${transcriptRoleLabel(file.role)} · ${formatFileSize(file.size)} · ${formatModifiedTime(file.modified_at)}`}
                    title={file.name}
                    trailing={
                      <IconButton
                        accessibilityLabel={`Share ${file.name}`}
                        disabled={!hasHostFileStreams(transport)}
                        icon="Download"
                        onPress={() => void share(file)}
                        size="sm"
                        variant="ghost"
                      />
                    }
                  />
                </Fragment>
              ))}
            </View>
          )}
          {report.data?.truncated && !notice && !busy ? (
            <Text color="mutedForeground" style={{ paddingTop: theme.space(2) }} variant="caption">
              Only the newest are listed; older conversations stay on the host.
            </Text>
          ) : null}
          {transfer ? (
            <Text
              accessibilityLiveRegion="polite"
              color="mutedForeground"
              style={{ paddingTop: theme.space(2) }}
              variant="caption"
            >
              {transfer}
            </Text>
          ) : null}
        </SheetScrollView>
      </Sheet>
      {selected ? (
        <FileViewer
          entry={selected}
          onDismiss={() => setSelected(null)}
          {...(selectedIndex >= 0 && selectedIndex < transcripts.length - 1
            ? { onNext: () => setSelected(entryOf(transcripts[selectedIndex + 1]) ?? null) }
            : {})}
          {...(selectedIndex > 0
            ? { onPrevious: () => setSelected(entryOf(transcripts[selectedIndex - 1]) ?? null) }
            : {})}
          transport={transport}
        />
      ) : null}
    </>
  );
}

/** A transcript as the file viewer wants it: a regular file with a size. */
function entryOf(file: AgentTranscriptFile | undefined): HostDirEntry | null {
  if (!file) return null;
  return {
    name: file.name,
    path: file.path,
    kind: "file",
    is_dir: false,
    size: file.size,
    modified_at: file.modified_at,
  };
}

const styles = StyleSheet.create({
  busy: { alignItems: "center", justifyContent: "center" },
});
