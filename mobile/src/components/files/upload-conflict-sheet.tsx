import { useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  conflictApplyToRest,
  conflictDecisionLabel,
  conflictQuestion,
} from "@/components/files/transfer-copy";
import { type ConflictDecision, conflictChoices } from "@/components/files/transfer-plan";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { spacing } from "@/theme";

/** A picked item whose name is taken where it is going, and what holds the name. */
export interface ConflictAsked {
  name: string;
  isDir: boolean;
  clashIsDir: boolean;
}

export interface ConflictQuestionProps {
  asked: ConflictAsked;
  folderLabel: string;
  hostName: string;
  /** How many more picked items are also taken. */
  others: number;
  onChoose(decision: ConflictDecision, applyToRest: boolean): void;
  /** Backing out sends none of what was picked. */
  onCancel(): void;
  testIDPrefix: string;
}

/**
 * "“notes.md” already exists in Documents on mac-mini." [Replace] [Keep both]
 * [Skip] — or, for a folder, "A folder named “photos” already exists…" with
 * Merge — and "Do this for the other 3" when there are more. A file and a
 * folder of the same name are never swapped, so between them only Keep both
 * and Skip are offered. Cancel is the phone's own way back out.
 */
export function ConflictQuestion({
  asked,
  folderLabel,
  hostName,
  others,
  onChoose,
  onCancel,
  testIDPrefix,
}: ConflictQuestionProps): React.JSX.Element {
  // Each item asked about starts with the switch off: callers key this by the item.
  const [applyToRest, setApplyToRest] = useState(false);
  const choices = conflictChoices(asked.isDir, asked.clashIsDir);
  return (
    <View style={styles.body}>
      <Text accessibilityRole="header" variant="uiLg" weight="semibold">
        {conflictQuestion({ name: asked.name, isDir: asked.isDir, folderLabel, hostName })}
      </Text>
      {others > 0 ? (
        <View style={styles.rest}>
          <Text style={styles.flex}>{conflictApplyToRest(others)}</Text>
          <Switch
            accessibilityLabel={conflictApplyToRest(others)}
            onValueChange={setApplyToRest}
            value={applyToRest}
          />
        </View>
      ) : null}
      <View style={styles.choices}>
        {choices.map((decision) => (
          <Button
            key={decision}
            onPress={() => onChoose(decision, applyToRest)}
            testID={`${testIDPrefix}-${decision}`}
            variant={decision === "keep_both" ? "default" : "outline"}
          >
            {conflictDecisionLabel(decision, asked.isDir && asked.clashIsDir)}
          </Button>
        ))}
        <Button onPress={onCancel} testID={`${testIDPrefix}-cancel`} variant="ghost">
          Cancel
        </Button>
      </View>
    </View>
  );
}

export interface UploadConflictSheetProps {
  /** The picked file whose name is taken; null hides the sheet. */
  asked: ConflictAsked | null;
  folderLabel: string;
  hostName: string;
  /** How many more picked files are also taken. */
  others: number;
  onChoose(decision: ConflictDecision, applyToRest: boolean): void;
  /** Dismissing uploads nothing. */
  onCancel(): void;
}

/**
 * Asked before an upload starts, for each picked file whose name the folder
 * already holds. Cancel, or dismissing the sheet, uploads none of what was
 * picked.
 */
export function UploadConflictSheet({
  asked,
  folderLabel,
  hostName,
  others,
  onChoose,
  onCancel,
}: UploadConflictSheetProps): React.JSX.Element {
  return (
    <Sheet onDismiss={onCancel} testID="upload-conflict-sheet" visible={asked !== null}>
      {asked ? (
        <ConflictQuestion
          asked={asked}
          folderLabel={folderLabel}
          hostName={hostName}
          key={asked.name}
          onCancel={onCancel}
          onChoose={onChoose}
          others={others}
          testIDPrefix="upload-conflict"
        />
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[4], paddingBottom: spacing[4], paddingHorizontal: spacing[4] },
  choices: { gap: spacing[2] },
  flex: { flex: 1 },
  rest: { alignItems: "center", flexDirection: "row", gap: spacing[3] },
});
