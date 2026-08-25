import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import type { CeremonyPhase } from "@/data/trust/ceremony";
import { CEREMONY_SAS_DIGITS } from "@/lib/crypto/sas";
import { fontFamily, fontSize, spacing, useTheme } from "@/theme";

/**
 * The one human check in the whole system (the committed SAS, mesh Appendix
 * A), shaped for a phone. `show`: this device is the new one and displays its
 * number for the approving screen to type. `enter`: this device approves, and
 * the human types the number the other screen shows. Presentation only; every
 * trust decision lives in `data/trust/ceremony.ts`.
 */
export function NumberCheck({
  mode,
  phase,
  number,
  otherScreen,
  entryError,
  onSubmit,
  onCancel,
  onDone,
}: {
  mode: "show" | "enter";
  phase: CeremonyPhase;
  number: string | null;
  /** Where the other half of the check is happening: "on your Mac's browser". */
  otherScreen: string;
  entryError?: string | null;
  onSubmit?: (digits: string) => void;
  onCancel: () => void;
  onDone?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const [entered, setEntered] = useState("");

  const submitIfComplete = (raw: string): void => {
    const digits = raw.replace(/\D/gu, "").slice(0, CEREMONY_SAS_DIGITS);
    setEntered(digits);
    if (digits.length === CEREMONY_SAS_DIGITS) {
      onSubmit?.(digits);
      setEntered("");
    }
  };

  if (phase === "connecting") {
    return (
      <View style={[styles.centered, { gap: theme.space(3) }]} testID="number-check-connecting">
        <Spinner label="Securing the connection" />
        <Text color="mutedForeground" variant="caption">
          Securing the connection
        </Text>
      </View>
    );
  }

  if (phase === "stopped") {
    return (
      <View style={[styles.centered, { gap: theme.space(3) }]} testID="number-check-stopped">
        <Text style={styles.textCenter} variant="label">
          Nothing was trusted
        </Text>
        <Text color="mutedForeground" style={styles.textCenter} variant="caption">
          {entryError ?? "The check did not complete. Start over from the other screen."}
        </Text>
        <Button onPress={onCancel} variant="outline">
          Close
        </Button>
      </View>
    );
  }

  if (phase === "done") {
    return (
      <View style={[styles.centered, { gap: theme.space(3) }]} testID="number-check-done">
        <Text style={styles.textCenter} variant="label">
          Approved
        </Text>
        <Text color="mutedForeground" style={styles.textCenter} variant="caption">
          {mode === "show"
            ? "This device can reach your hosts now."
            : "The other device can reach your hosts now."}
        </Text>
        <Button onPress={onDone ?? onCancel}>Done</Button>
      </View>
    );
  }

  if (phase === "waiting") {
    return (
      <View style={[styles.centered, { gap: theme.space(3) }]} testID="number-check-waiting">
        <Text style={styles.textCenter} variant="label">
          Almost there
        </Text>
        {number !== null ? (
          <Text color="mutedForeground" style={styles.number} variant="mono">
            {number}
          </Text>
        ) : null}
        <Text color="mutedForeground" style={styles.textCenter} variant="caption">
          Confirmed here. Finishing up {otherScreen}.
        </Text>
        <Spinner label="Waiting for the other side" />
      </View>
    );
  }

  if (mode === "show") {
    return (
      <View style={[styles.centered, { gap: theme.space(3) }]} testID="number-check-show">
        <Text style={styles.textCenter} variant="label">
          Your number
        </Text>
        <Text style={styles.number} variant="mono">
          {number ?? ""}
        </Text>
        <Text color="mutedForeground" style={styles.textCenter} variant="caption">
          Type this number {otherScreen}. It is only ever shown here.
        </Text>
        <Spinner label="Waiting for the other side" />
        <Button onPress={onCancel} size="sm" variant="ghost">
          Cancel
        </Button>
      </View>
    );
  }

  return (
    <View style={[styles.centered, { gap: theme.space(3) }]} testID="number-check-enter">
      <Text style={styles.textCenter} variant="label">
        Enter the number
      </Text>
      <Input
        accessibilityLabel={`The ${CEREMONY_SAS_DIGITS}-digit number shown ${otherScreen}`}
        autoFocus
        error={entryError != null}
        keyboardType="number-pad"
        maxLength={CEREMONY_SAS_DIGITS}
        onChangeText={submitIfComplete}
        placeholder={"0".repeat(CEREMONY_SAS_DIGITS)}
        purpose="oneTimeCode"
        style={styles.entry}
        testID="number-entry"
        value={entered}
      />
      <Text
        accessibilityRole={entryError ? "alert" : undefined}
        color={entryError ? "destructive" : "mutedForeground"}
        style={styles.textCenter}
        variant="caption"
      >
        {entryError ?? `Type the number shown ${otherScreen}.`}
      </Text>
      <Button onPress={onCancel} size="sm" variant="ghost">
        I don't see a number
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: "center",
    paddingVertical: spacing[2],
  },
  entry: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.displayMd,
    letterSpacing: spacing[2],
    minWidth: 180,
    textAlign: "center",
  },
  number: {
    fontSize: fontSize.displayLg,
    letterSpacing: spacing[2],
    textAlign: "center",
  },
  textCenter: {
    textAlign: "center",
  },
});
