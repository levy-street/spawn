import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  breadcrumbParts,
  isWithinHome,
  type PathFlavor,
  pathFlavorForHostOS,
} from "@/components/files/paths";
import {
  CONFLICT_POLICY_COPY,
  CONFLICT_POLICY_LABEL,
  countingNotice,
  linksSkipped,
  NO_OTHER_HOST,
  PERMISSIONS_NOT_COPIED,
  proceedAnywayLabel,
  relayWarning,
  SEND_PICK_HOST_TITLE,
  sendButtonLabel,
  sendDestinationLine,
  sendDestinationTitle,
  sendSummary,
  specialSkipped,
  tooLargeFile,
  tooLargeSkipped,
  tooManyItems,
  truncatedSendNotice,
} from "@/components/files/transfer-copy";
import {
  CONFLICT_POLICIES,
  type ConflictDecision,
  type ConflictPolicy,
  destinationPath,
  estimateSeconds,
  expectedRate,
  needsRelayWarning,
  planSend,
  relayedHosts,
  SEND_ITEM_LIMIT,
  type SendPlan,
  worthEstimating,
} from "@/components/files/transfer-plan";
import type { HostDirEntry } from "@/components/files/types";
import { type ConflictAsked, ConflictQuestion } from "@/components/files/upload-conflict-sheet";
import { FolderPicker } from "@/components/launcher/folder-picker";
import { useDeviceApprovalGate } from "@/components/trust/device-approval-gate";
import { Button } from "@/components/ui/button";
import { DrawerRow } from "@/components/ui/drawer-row";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetHeader, SheetScrollView } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import type { HostOut } from "@/data/api/schemas/hosts";
import { fetchHostDirectoryPage, fetchHostHome, fetchHostListing } from "@/data/queries/files";
import { useHostsQuery } from "@/data/queries/hosts";
import { sortHosts } from "@/data/selectors/host";
import {
  type NewTransferItem,
  type TransferHost,
  useTransfersStore,
} from "@/data/stores/transfers";
import { haptics } from "@/lib/haptics";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import type { HostTransport, TransportState } from "@/terminal/transport/types";
import { borderWidth, spacing, useTheme } from "@/theme";

type Step = "host" | "folder" | "confirm" | "conflicts";

/** The picked items still to be asked about, and the answers so far, by name. */
interface Questions {
  asked: ConflictAsked[];
  decisions: ReadonlyMap<string, ConflictDecision>;
}

export interface SendToHostSheetProps {
  visible: boolean;
  /** The host the items are on. */
  source: TransferHost;
  /** The browser's own channel to it, which counts what is being sent. */
  sourceTransport: HostTransport | null;
  /** The folder the items are in, and the host's home, to offer the same place on the other host. */
  sourceFolder: string;
  sourceHomeDir: string;
  entries: readonly HostDirEntry[];
  onDismiss(): void;
}

/** The folder as a person reads it in a sentence: "Documents", or "Home". */
export function folderLabel(path: string, homeDir: string, flavor: PathFlavor): string {
  return breadcrumbParts(path, homeDir, flavor).at(-1)?.label ?? path;
}

/** The same place below home on another host: "~/code/spawn" there for "~/code/spawn" here. */
export function samePlaceOn(
  sourceFolder: string,
  sourceHome: string,
  sourceFlavor: PathFlavor,
  destHome: string,
  destFlavor: PathFlavor,
): string {
  const names = breadcrumbParts(sourceFolder, sourceHome, sourceFlavor)
    .slice(1)
    .map((crumb) => crumb.label);
  return destinationPath(destHome, names, destFlavor);
}

/**
 * "Send to another host…": which host, which folder on it, and what to do with
 * a name already taken there — "Ask each time" unless the person says
 * otherwise, each picked item answered for itself and everything in it. What
 * is sent is counted while the person chooses, so the button can say how
 * much, and a send that goes through the relay can say so, and about how long
 * it will take, before it starts (OD3). The files then go one at a time
 * through the Transfers queue, from host to phone to host: the server never
 * carries a byte (docs/TRUST.md).
 */
export function SendToHostSheet({
  visible,
  source,
  sourceTransport,
  sourceFolder,
  sourceHomeDir,
  entries,
  onDismiss,
}: SendToHostSheetProps): React.JSX.Element {
  const theme = useTheme();
  const gate = useDeviceApprovalGate();
  const enqueue = useTransfersStore((state) => state.enqueue);
  const routeRates = useTransfersStore((state) => state.routeRates);
  const hostsQuery = useHostsQuery({ enabled: visible });
  const [step, setStep] = useState<Step>("host");
  const [dest, setDest] = useState<HostOut | null>(null);
  const [destTransport, setDestTransport] = useState<HostTransport | null>(null);
  const [destState, setDestState] = useState<TransportState>("idle");
  const [destHome, setDestHome] = useState<string | null>(null);
  const [startAt, setStartAt] = useState<string | null>(null);
  const [destDir, setDestDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<SendPlan | null>(null);
  const [counted, setCounted] = useState(0);
  const [planError, setPlanError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<ConflictPolicy>("ask");
  const [checking, setChecking] = useState(false);
  const [questions, setQuestions] = useState<Questions | null>(null);
  const sourceFlavor = pathFlavorForHostOS(source.os);
  const destFlavor = pathFlavorForHostOS(dest?.os);

  // Every opening starts afresh.
  useEffect(() => {
    if (!visible) return;
    setStep("host");
    setDest(null);
    setDestTransport(null);
    setDestState("idle");
    setDestHome(null);
    setStartAt(null);
    setDestDir(null);
    setError(null);
    setPolicy("ask");
    setChecking(false);
    setQuestions(null);
  }, [visible]);

  // Counted once per opening, while the person picks where it goes.
  const sourceReady = sourceTransport !== null && sourceTransport.state === "ready";
  useEffect(() => {
    if (!visible || !sourceReady || !sourceTransport) return;
    const controller = new AbortController();
    setPlan(null);
    setPlanError(null);
    setCounted(0);
    void planSend({
      entries,
      listFolder: (path) => fetchHostListing(sourceTransport, path),
      signal: controller.signal,
      onProgress: setCounted,
    })
      .then((made) => {
        if (!controller.signal.aborted) setPlan(made);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setPlanError(
          cause instanceof Error && cause.message.trim()
            ? cause.message
            : `SPAWN D couldn't count what to send on ${source.name}.`,
        );
      });
    return () => controller.abort();
  }, [entries, source.name, sourceReady, sourceTransport, visible]);

  // On the other host, the same place if it has one; home otherwise.
  const destReady = destTransport !== null && destState === "ready";
  useEffect(() => {
    if (!destReady || !destTransport || destHome !== null) return;
    let active = true;
    void (async () => {
      try {
        const { home_dir: home } = await fetchHostHome(destTransport);
        const same = samePlaceOn(sourceFolder, sourceHomeDir, sourceFlavor, home, destFlavor);
        let start = home;
        if (isWithinHome(same, home, destFlavor)) {
          try {
            await fetchHostDirectoryPage(destTransport, same, 0);
            start = same;
          } catch {
            start = home;
          }
        }
        if (!active) return;
        setDestHome(home);
        setStartAt(start);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "The host did not answer.");
      }
    })();
    return () => {
      active = false;
    };
  }, [destFlavor, destHome, destReady, destTransport, sourceFlavor, sourceFolder, sourceHomeDir]);

  const handleTransport = useCallback((next: HostTransport) => setDestTransport(next), []);

  const hosts = useMemo(
    () => sortHosts((hostsQuery.data ?? []).filter((host) => host.id !== source.id)),
    [hostsQuery.data, source.id],
  );

  const pickHost = (host: HostOut) => {
    haptics.selection();
    gate.guard(host.id, () => {
      setDest(host);
      setDestTransport(null);
      setDestState("idle");
      setDestHome(null);
      setStartAt(null);
      setDestDir(null);
      setError(null);
      setStep("folder");
    });
  };

  const back = () => {
    haptics.selection();
    setError(null);
    if (step === "conflicts") {
      setQuestions(null);
      setStep("confirm");
    } else if (step === "confirm") setStep("folder");
    else if (step === "folder") setStep("host");
  };

  const relayed =
    dest && step === "confirm"
      ? relayedHosts([
          { name: source.name, info: sourceTransport?.connectionInfo },
          { name: dest.name, info: destTransport?.connectionInfo },
        ])
      : [];
  const warnRelay = plan !== null && needsRelayWarning(plan.totalBytes, relayed);
  const relayEstimate = (() => {
    if (!warnRelay || !plan || !dest) return null;
    const seconds = estimateSeconds(
      plan.totalBytes,
      expectedRate(
        [
          { hostId: source.id, info: sourceTransport?.connectionInfo },
          { hostId: dest.id, info: destTransport?.connectionInfo },
        ],
        routeRates,
      ),
    );
    return worthEstimating(seconds) ? seconds : null;
  })();

  const destLabel = dest && destDir && destHome ? folderLabel(destDir, destHome, destFlavor) : "";
  const names = entries.map((entry) => entry.name);

  /** Into the queue: each picked item with its own answer, everything inside it asking only if it must. */
  const queue = (decisions: ReadonlyMap<string, ConflictDecision>) => {
    if (!dest?.host_public_key || !destDir || !destHome || !plan || plan.tooMany !== null) return;
    haptics.success();
    const policyOf = (relative: readonly string[]): ConflictPolicy =>
      relative.length === 1 ? (decisions.get(relative[0] ?? "") ?? policy) : "ask";
    const item = (planned: SendPlan["items"][number]): NewTransferItem => ({
      kind: planned.kind,
      name: planned.relative[planned.relative.length - 1] ?? "",
      relative: planned.relative,
      size: planned.size,
      source: { kind: "host", path: planned.sourcePath },
      policy: policyOf(planned.relative),
    });
    enqueue({
      kind: "send",
      source,
      destination: {
        id: dest.id,
        name: dest.name,
        publicKey: dest.host_public_key,
        os: dest.os ?? null,
      },
      destDir,
      destLabel,
      names,
      items: plan.items.map(item),
      refused: plan.tooLarge.map((planned) => ({
        item: item(planned),
        reason: tooLargeFile(planned.relative[planned.relative.length - 1] ?? ""),
      })),
    });
    onDismiss();
  };

  /**
   * "Ask each time" asks here, before anything is queued, about each picked
   * item the folder already holds. A name the listing could not show is
   * asked about in the Transfers sheet when its turn comes.
   */
  const send = async () => {
    if (!plan || !destDir || !destTransport) return;
    if (policy !== "ask") {
      queue(new Map());
      return;
    }
    setChecking(true);
    try {
      const fold = (name: string) => (destFlavor === "windows" ? name.toLocaleLowerCase() : name);
      const listing = await fetchHostListing(destTransport, destDir);
      const there = new Map(
        listing.entries.map((entry) => [fold(entry.name), entry.is_dir === true]),
      );
      const asked = plan.items
        .filter((planned) => planned.relative.length === 1)
        .flatMap((planned): ConflictAsked[] => {
          const name = planned.relative[0] ?? "";
          const clashIsDir = there.get(fold(name));
          return clashIsDir === undefined
            ? []
            : [{ name, isDir: planned.kind === "folder", clashIsDir }];
        });
      if (asked.length > 0) {
        setQuestions({ asked, decisions: new Map() });
        setStep("conflicts");
        return;
      }
    } catch {
      // The folder could not be read now: each name is asked about when it is reached.
    } finally {
      setChecking(false);
    }
    queue(new Map());
  };

  const answer = (decision: ConflictDecision, applyToRest: boolean) => {
    if (!questions) return;
    const [current, ...rest] = questions.asked;
    if (!current) return;
    const decisions = new Map(questions.decisions);
    for (const asked of applyToRest ? questions.asked : [current]) {
      decisions.set(asked.name, decision);
    }
    const left = applyToRest ? [] : rest;
    if (left.length === 0) {
      setQuestions(null);
      queue(decisions);
      return;
    }
    setQuestions({ asked: left, decisions });
  };

  const sendLabel = sendButtonLabel(names, dest?.name ?? "");
  const title =
    step === "host"
      ? SEND_PICK_HOST_TITLE
      : step === "folder"
        ? sendDestinationTitle(dest?.name ?? "")
        : sendLabel;

  const hostRows = (
    <SheetScrollView contentContainerStyle={styles.list}>
      {hostsQuery.isPending ? (
        <View style={styles.centered}>
          <Spinner size={spacing[6]} />
        </View>
      ) : hostsQuery.isError ? (
        <Text color="destructive" style={styles.note}>
          SPAWN D couldn't load your hosts. Close this and try again.
        </Text>
      ) : hosts.length === 0 ? (
        <Text color="mutedForeground" style={styles.note}>
          {NO_OTHER_HOST}
        </Text>
      ) : (
        hosts.map((host) => {
          const online = host.status === "online";
          const reachable = online && host.host_public_key !== null;
          const detail = !online
            ? "Offline"
            : host.host_public_key === null
              ? "Reconnect this host to establish its trusted identity before sending to it."
              : undefined;
          return (
            <DrawerRow
              {...(detail === undefined ? {} : { detail })}
              disabled={!reachable}
              icon={<StatusDot tone={online ? "active" : "offline"} />}
              key={host.id}
              label={host.name}
              onPress={() => pickHost(host)}
              testID={`send-host-${host.id}`}
            />
          );
        })
      )}
    </SheetScrollView>
  );

  const counting = plan === null && planError === null;
  const confirm = (
    <SheetScrollView contentContainerStyle={styles.confirm}>
      <View style={styles.section}>
        <Text color="mutedForeground" variant="caption">
          {dest && destLabel ? sendDestinationLine(destLabel, dest.name) : ""}
        </Text>
        {counting ? (
          <View style={styles.inline}>
            <Spinner size={spacing[4]} />
            <Text color="mutedForeground">{countingNotice(source.name, counted)}</Text>
          </View>
        ) : planError ? (
          <Text color="destructive">{planError}</Text>
        ) : plan && plan.tooMany === null ? (
          <Text variant="label" weight="semibold">
            {sendSummary(plan.files, plan.folders, plan.totalBytes)}
          </Text>
        ) : null}
        {plan ? (
          <View style={styles.notes}>
            {plan.tooMany !== null ? (
              <Text color="destructive">{tooManyItems(plan.tooMany, SEND_ITEM_LIMIT)}</Text>
            ) : null}
            {plan.truncated.length > 0 ? (
              <Text color="warning">{truncatedSendNotice(plan.truncated, source.name)}</Text>
            ) : null}
            {plan.tooLarge.length > 0 ? (
              <Text color="warning">
                {tooLargeSkipped(plan.tooLarge.map((file) => file.relative.join("/")))}
              </Text>
            ) : null}
            {plan.links > 0 ? (
              <Text color="mutedForeground">{linksSkipped(plan.links)}</Text>
            ) : null}
            {plan.special > 0 ? (
              <Text color="mutedForeground">{specialSkipped(plan.special)}</Text>
            ) : null}
            <Text color="mutedForeground">{PERMISSIONS_NOT_COPIED}</Text>
          </View>
        ) : null}
        <Text accessibilityRole="header" variant="label">
          {CONFLICT_POLICY_LABEL}
        </Text>
      </View>
      <View accessibilityLabel={CONFLICT_POLICY_LABEL} accessibilityRole="radiogroup">
        {CONFLICT_POLICIES.map((value) => (
          <DrawerRow
            accessibilityRole="radio"
            detail={CONFLICT_POLICY_COPY[value].detail}
            key={value}
            label={CONFLICT_POLICY_COPY[value].label}
            onPress={() => {
              haptics.selection();
              setPolicy(value);
            }}
            selected={policy === value}
            testID={`send-conflict-policy-${value}`}
            {...(policy === value
              ? { trailing: <Icon color="popoverForeground" name="Check" /> }
              : {})}
          />
        ))}
      </View>
      <View style={styles.section}>
        {warnRelay && plan ? (
          <View style={[styles.warning, { backgroundColor: theme.colors.warningSoft }]}>
            <Icon color="warning" name="AlertTriangle" />
            <Text color="warning" style={styles.flex}>
              {relayWarning(relayed, plan.totalBytes, relayEstimate)}
            </Text>
          </View>
        ) : null}
        <View style={styles.actions}>
          <Button onPress={onDismiss} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!plan || plan.tooMany !== null || plan.items.length === 0 || checking}
            onPress={() => void send()}
            testID="send-confirm"
          >
            {warnRelay ? proceedAnywayLabel("send") : sendLabel}
          </Button>
        </View>
      </View>
    </SheetScrollView>
  );

  const asking = questions?.asked[0];
  const conflicts =
    asking && dest ? (
      <SheetScrollView>
        <ConflictQuestion
          asked={asking}
          folderLabel={destLabel}
          hostName={dest.name}
          key={asking.name}
          onCancel={back}
          onChoose={answer}
          others={(questions?.asked.length ?? 1) - 1}
          testIDPrefix="send-conflict"
        />
      </SheetScrollView>
    ) : null;

  return (
    <>
      <Sheet onDismiss={onDismiss} size="tall" testID="send-to-host-sheet" visible={visible}>
        {step === "host" ? (
          <SheetHeader title={title} />
        ) : (
          <View style={[styles.stepBar, { borderBottomColor: theme.colors.border }]}>
            <IconButton accessibilityLabel="Go back" icon="ChevronLeft" onPress={back} size="sm" />
            <Text numberOfLines={1} style={styles.stepTitle} variant="label">
              {title}
            </Text>
            <View style={styles.backPlaceholder} />
          </View>
        )}
        {error ? (
          <View style={[styles.error, { backgroundColor: theme.colors.destructiveSoft }]}>
            <Text accessibilityRole="alert" color="destructive">
              {error}
            </Text>
          </View>
        ) : null}
        {step === "host" ? (
          hostRows
        ) : step === "folder" ? (
          startAt === null ? (
            <View style={styles.centered}>
              <Spinner size={spacing[6]} />
              <Text color="mutedForeground" variant="caption">
                Connecting to host…
              </Text>
            </View>
          ) : (
            <FolderPicker
              initialPath={startAt}
              onSelect={(path) => {
                haptics.selection();
                setDestDir(path);
                setStep("confirm");
              }}
              pathFlavor={destFlavor}
              recentDirectories={[]}
              transport={destTransport}
              transportState={destState}
            />
          )
        ) : step === "conflicts" ? (
          conflicts
        ) : (
          confirm
        )}
        {visible && dest?.host_public_key && step !== "host" ? (
          <HostTransportSurface
            hostId={dest.id}
            hostIdentityPublicKey={dest.host_public_key}
            key={dest.id}
            onError={(transportError) => setError(transportError.message)}
            onStateChange={setDestState}
            onTransport={handleTransport}
          />
        ) : null}
      </Sheet>
      {gate.overlay}
    </>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: spacing[2], justifyContent: "flex-end" },
  backPlaceholder: { height: spacing[9], width: spacing[9] },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: spacing[3],
    justifyContent: "center",
    padding: spacing[6],
  },
  confirm: { gap: spacing[3], paddingVertical: spacing[4] },
  error: { margin: spacing[4], padding: spacing[3] },
  flex: { flex: 1 },
  inline: { alignItems: "center", flexDirection: "row", gap: spacing[2] },
  list: { paddingBottom: spacing[2] },
  note: { padding: spacing[4] },
  notes: { gap: spacing[1] },
  section: { gap: spacing[3], paddingHorizontal: spacing[4] },
  stepBar: {
    alignItems: "center",
    borderBottomWidth: borderWidth.hairline,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: spacing[2],
    paddingHorizontal: spacing[4],
  },
  stepTitle: { flex: 1, textAlign: "center" },
  warning: { alignItems: "flex-start", flexDirection: "row", gap: spacing[2], padding: spacing[3] },
});
