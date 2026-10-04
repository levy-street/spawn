import { Children, type ReactNode, useEffect, useState } from "react";
import { AccessibilityInfo, Platform, StyleSheet, View } from "react-native";
import { ActionSheet } from "@/components/ui/action-sheet";
import { Button } from "@/components/ui/button";
import { FooterActions } from "@/components/ui/footer-actions";
import { Icon } from "@/components/ui/icon";
import { ListRow } from "@/components/ui/list-row";
import { Sheet } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import type {
  MoveAction,
  MovePhase,
  MovePreview,
} from "@/components/workspace-detail/move-conversation";
import * as copy from "@/components/workspace-detail/move-copy";
import type { ResolveOutcome } from "@/components/workspace-detail/move-resolve";
import {
  formatCarryProgress,
  PERMISSION_MODE_CHOICES,
  PERMISSION_MODES,
  type PermissionMode,
  permissionModeLabel,
} from "@/data/selectors/move-facts";
import { spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

/**
 * The phone's Move dialog, its progress and its Resolve: a confirm sheet
 * with the same checks, copy and three actions as the browser's dialog, a
 * sheet that follows the move, and the sheet that asks before Resolve acts.
 * Every word is `move-copy.ts`'s.
 */

export type MoveConfirmState =
  | { readonly kind: "checking"; readonly from: string; readonly to: string }
  | MovePreview;

export interface MoveConfirmSheetProps {
  visible: boolean;
  state: MoveConfirmState | null;
  toName: string;
  onCancel: () => void;
  onStartFresh: () => void;
  onMove: (mode: PermissionMode) => void;
}

/**
 * The answers, given in a confirm's row order — the primary last, on the
 * right. Two sit side by side; three are stacked with the primary on top,
 * since three labels this long do not fit a phone's row.
 */
function MoveActions({ children }: { children: ReactNode }): React.JSX.Element {
  const actions = Children.toArray(children);
  if (actions.length <= 2) return <FooterActions>{actions}</FooterActions>;
  return <View style={styles.stack}>{actions.reverse()}</View>;
}

function Lines({
  lines,
  color,
}: {
  lines: readonly string[];
  color: "warning" | "mutedForeground";
}) {
  return (
    <>
      {lines.map((line) => (
        <View key={line} style={styles.line}>
          {color === "warning" ? (
            <Icon color="warning" name="AlertTriangle" size={spacing[4]} />
          ) : null}
          <Text color={color} style={styles.lineText} variant="caption">
            {line}
          </Text>
        </View>
      ))}
    </>
  );
}

/** A step said where VoiceOver hears it: iOS honours no live region. */
function useAnnounce(message: string | null): void {
  useEffect(() => {
    if (message && Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(message);
  }, [message]);
}

export function MoveConfirmSheet({
  visible,
  state,
  toName,
  onCancel,
  onStartFresh,
  onMove,
}: MoveConfirmSheetProps): React.JSX.Element {
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<PermissionMode | null>(null);
  const ready = state?.kind === "ready" ? state : null;
  const mode = chosen ?? ready?.dialog.defaultMode ?? "default";
  const dismiss = () => {
    setChosen(null);
    onCancel();
  };
  const startFreshLabel =
    state?.kind === "blocked" && state.startFresh === "on_target"
      ? copy.moveStartFreshOn(toName)
      : copy.MOVE_START_FRESH;

  return (
    <>
      <Sheet onDismiss={dismiss} testID="move-confirm-sheet" visible={visible && !picking}>
        <View style={styles.body}>
          {state === null || state.kind === "checking" ? (
            <>
              <Text accessibilityRole="header" variant="uiLg" weight="semibold">
                {copy.moveTitle(toName)}
              </Text>
              <View style={styles.checking}>
                <Spinner />
                <Text color="mutedForeground" variant="body">
                  {state ? copy.moveChecking(state.from, state.to) : ""}
                </Text>
              </View>
            </>
          ) : state.kind === "ready" ? (
            <>
              <Text accessibilityRole="header" variant="uiLg" weight="semibold">
                {state.dialog.title}
              </Text>
              <Text color="mutedForeground" variant="body">
                {state.dialog.body}
              </Text>
              <Text variant="body">{state.dialog.stateLine}</Text>
              <Lines color="mutedForeground" lines={state.dialog.info} />
              <Lines color="warning" lines={state.dialog.warnings} />
              <ListRow
                onPress={() => setPicking(true)}
                subtitle={PERMISSION_MODE_CHOICES[mode].description}
                title={copy.moveStartsIn(permissionModeLabel(mode))}
                trailing={<Icon name="ChevronDown" />}
              />
            </>
          ) : (
            <>
              <Text accessibilityRole="header" variant="uiLg" weight="semibold">
                {copy.moveTitle(toName)}
              </Text>
              <Text color="mutedForeground" variant="body">
                {state.reason}
              </Text>
            </>
          )}
        </View>
        <MoveActions>
          <Button onPress={dismiss} variant="outline">
            {copy.MOVE_CANCEL}
          </Button>
          {state?.kind === "ready" || state?.kind === "fresh" || state?.kind === "blocked" ? (
            <Button
              onPress={() => {
                setChosen(null);
                onStartFresh();
              }}
              variant={state.kind === "ready" ? "secondary" : "default"}
            >
              {startFreshLabel}
            </Button>
          ) : null}
          {state?.kind === "ready" ? (
            <Button
              onPress={() => {
                setChosen(null);
                onMove(mode);
              }}
            >
              {copy.MOVE_WITH_CONVERSATION}
            </Button>
          ) : null}
        </MoveActions>
      </Sheet>
      <ActionSheet
        actions={PERMISSION_MODES.map((candidate) => ({
          id: candidate,
          label: PERMISSION_MODE_CHOICES[candidate].label,
          detail: PERMISSION_MODE_CHOICES[candidate].description,
          selected: candidate === mode,
          accessibilityRole: "radio" as const,
          onPress: () => {
            setChosen(candidate);
            setPicking(false);
          },
        }))}
        message={copy.moveModePickerMessage(toName)}
        onDismiss={() => setPicking(false)}
        title={copy.MOVE_MODE_PICKER_TITLE}
        visible={visible && picking}
      />
    </>
  );
}

/** The step a move is on, as the progress sheet says it. */
export function moveStepLine(phase: MovePhase, names: { from: string; to: string }): string | null {
  switch (phase.step) {
    case "beginning":
    case "stopping":
      return copy.moveStopping(names.from);
    case "copying": {
      const progress = formatCarryProgress(phase.sent, phase.total);
      return copy.moveCopying(progress.done, progress.total);
    }
    case "starting":
      return copy.moveStarting(names.to);
    case "restoring":
      return copy.movePuttingBack(names.from);
    default:
      return null;
  }
}

export function moveActionLabel(action: MoveAction, from: string, to: string): string {
  switch (action) {
    case "retry":
      return copy.MOVE_TRY_AGAIN;
    case "resume_source":
      return copy.moveResumeOn(from);
    case "start_fresh":
      return copy.moveStartFreshOn(to);
    case "give_up":
      return copy.MOVE_GIVE_UP;
    case "take_there":
      return copy.moveTakeThere(to);
    default:
      return copy.MOVE_CLOSE;
  }
}

export interface MoveProgressSheetProps {
  visible: boolean;
  phase: MovePhase;
  names: { from: string; to: string };
  /** Cancel is offered until the target has committed. */
  cancellable: boolean;
  busy: boolean;
  onCancel: () => void;
  onAction: (action: MoveAction) => void;
  /** Put the sheet away; the move goes on. */
  onHide: () => void;
}

export function MoveProgressSheet({
  visible,
  phase,
  names,
  cancellable,
  busy,
  onCancel,
  onAction,
  onHide,
}: MoveProgressSheetProps): React.JSX.Element {
  const theme = useTheme();
  const step = moveStepLine(phase, names);
  const failure = phase.step === "failed" ? phase.failure : null;
  const progress =
    phase.step === "copying" && phase.total > 0 ? Math.min(1, phase.sent / phase.total) : null;
  // A step's name is announced as it changes, not every byte it copies.
  useAnnounce(phase.step === "copying" ? copy.MOVE_COPYING : step);
  useAnnounce(failure?.message ?? (phase.step === "restored" ? phase.message : null));
  return (
    <Sheet onDismiss={onHide} testID="move-progress-sheet" visible={visible}>
      <View style={styles.body}>
        <Text accessibilityRole="header" variant="uiLg" weight="semibold">
          {copy.moveProgressTitle(names.to)}
        </Text>
        {step ? (
          <View style={styles.checking}>
            <Spinner />
            <Text
              accessibilityLiveRegion="polite"
              color="mutedForeground"
              testID="move-progress-step"
              variant="body"
            >
              {step}
            </Text>
          </View>
        ) : null}
        {progress !== null ? (
          <View
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
            style={[styles.track, { backgroundColor: theme.colors.muted }]}
            testID="move-progress-bar"
          >
            <View
              style={[styles.fill, { backgroundColor: theme.colors.primary, flex: progress }]}
            />
            <View style={{ flex: 1 - progress }} />
          </View>
        ) : null}
        {step ? (
          <Text color="mutedForeground" variant="caption">
            {copy.MOVE_KEEP_OPEN}
          </Text>
        ) : null}
        {failure ? (
          <>
            <Text accessibilityLiveRegion="polite" testID="move-failure" variant="body">
              {failure.message}
            </Text>
            {failure.detail ? (
              <Text color="mutedForeground" variant="caption">
                {failure.detail}
              </Text>
            ) : null}
          </>
        ) : null}
        {phase.step === "restored" ? (
          <Text accessibilityLiveRegion="polite" variant="body">
            {phase.message}
          </Text>
        ) : null}
      </View>
      <MoveActions>
        {step ? (
          <Button
            disabled={!cancellable || phase.step === "restoring"}
            onPress={onCancel}
            variant="outline"
          >
            {copy.MOVE_CANCEL}
          </Button>
        ) : failure ? (
          // The first action is the one the failure suggests: it goes last,
          // where a confirm's primary sits.
          [...failure.actions].reverse().map((action) => (
            <Button
              key={action}
              loading={busy && action !== "close"}
              onPress={() => onAction(action)}
              variant={action === failure.actions[0] && action !== "close" ? "default" : "outline"}
            >
              {moveActionLabel(action, names.from, names.to)}
            </Button>
          ))
        ) : (
          <Button onPress={() => onAction("close")} variant="outline">
            {copy.MOVE_CLOSE}
          </Button>
        )}
      </MoveActions>
    </Sheet>
  );
}

// ---- Resolve -------------------------------------------------------------------

export type MoveResolveState =
  | { readonly kind: "confirm" }
  | { readonly kind: "resolving" }
  /** What the hosts said, when it needs the person: a host that cannot
   *  answer (Give up on offer), files that need sorting by hand. */
  | { readonly kind: "outcome"; readonly outcome: ResolveOutcome };

export interface MoveResolveSheetProps {
  visible: boolean;
  /** The host the window started moving from. */
  sourceName: string;
  state: MoveResolveState;
  /** Whether the window still reads "moving": giving it up needs one. */
  canGiveUp: boolean;
  onResolve: () => void;
  onGiveUp: () => void;
  onDismiss: () => void;
}

/**
 * Resolve asks before it acts and says what it will do: the source and the
 * host it was going to are asked where the conversation is, then the move
 * is finished or put back. While it works it says whom it is asking. A host
 * that cannot answer leaves the move as it is, with "Give up the move" on
 * offer and what giving up would leave said beside it.
 */
export function MoveResolveSheet({
  visible,
  sourceName,
  state,
  canGiveUp,
  onResolve,
  onGiveUp,
  onDismiss,
}: MoveResolveSheetProps): React.JSX.Element {
  const busy = state.kind === "resolving";
  const outcome = state.kind === "outcome" ? state.outcome : null;
  const giveUp = outcome?.kind === "unreachable" && canGiveUp ? outcome.giveUp : null;
  const message =
    outcome?.message ?? (busy ? copy.moveResolving(sourceName) : copy.moveResolveBody(sourceName));
  useAnnounce(busy || outcome ? message : null);
  return (
    <Sheet
      onDismiss={() => {
        if (!busy) onDismiss();
      }}
      testID="move-resolve-sheet"
      visible={visible}
    >
      <View style={styles.body}>
        <Text accessibilityRole="header" variant="uiLg" weight="semibold">
          {copy.MOVE_RESOLVE_TITLE}
        </Text>
        <View style={styles.checking}>
          {busy ? <Spinner /> : null}
          <Text
            accessibilityLiveRegion="polite"
            color={outcome ? "foreground" : "mutedForeground"}
            style={styles.lineText}
            testID="move-resolve-message"
            variant="body"
          >
            {message}
          </Text>
        </View>
        {outcome?.kind === "stranded" && outcome.detail ? (
          <Text color="mutedForeground" variant="caption">
            {outcome.detail}
          </Text>
        ) : null}
        {giveUp ? <Lines color="mutedForeground" lines={[giveUp]} /> : null}
      </View>
      <MoveActions>
        {outcome ? (
          <>
            <Button onPress={onDismiss} variant="outline">
              {copy.MOVE_DISMISS}
            </Button>
            {giveUp ? (
              <Button onPress={onGiveUp} variant="outline">
                {copy.MOVE_GIVE_UP}
              </Button>
            ) : null}
            {outcome.kind === "unreachable" || outcome.kind === "failed" ? (
              <Button onPress={onResolve}>{copy.MOVE_RESOLVE}</Button>
            ) : null}
          </>
        ) : (
          <>
            <Button disabled={busy} onPress={onDismiss} variant="outline">
              {copy.MOVE_CANCEL}
            </Button>
            <Button loading={busy} onPress={onResolve}>
              {copy.MOVE_RESOLVE}
            </Button>
          </>
        )}
      </MoveActions>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: sizing.space.peer,
    paddingBottom: sizing.space.block,
    paddingHorizontal: sizing.space.block,
    paddingTop: sizing.space.tight,
  },
  checking: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.space.peer,
  },
  fill: {
    borderRadius: sizing.space.tight,
  },
  line: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: sizing.space.tight,
  },
  lineText: {
    flex: 1,
  },
  stack: {
    gap: sizing.space.peer,
    paddingBottom: sizing.space.block,
    paddingHorizontal: sizing.space.block,
  },
  track: {
    borderRadius: sizing.space.tight,
    flexDirection: "row",
    height: sizing.space.tight,
    overflow: "hidden",
  },
});
