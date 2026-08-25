import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { formatPairingCodeInput, pairingCodeError } from "@/components/onboarding/pairing-code";
import { PairingWaitingEscape } from "@/components/onboarding/pairing-countdown";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { fontFamily, fontSize, spacing } from "@/theme";

export interface PairingCodeEntryProps {
  busy: boolean;
  error?: string | null;
  onBack: () => void;
  onSubmit: (code: string) => void;
}

export function PairingCodeEntry({ busy, error, onBack, onSubmit }: PairingCodeEntryProps) {
  const [code, setCode] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const validationError = submitted ? pairingCodeError(code) : null;

  const submit = () => {
    setSubmitted(true);
    if (pairingCodeError(code) === null) onSubmit(code);
  };

  return (
    <View style={styles.container}>
      <View style={styles.heading}>
        <Text accessibilityRole="header" variant="title">
          Enter the code from Terminal
        </Text>
        <Text color="mutedForeground">
          spawnd possess shows an eight-character code. It is valid for 30 minutes.
        </Text>
      </View>

      <Field
        error={validationError ?? error ?? null}
        hint="Eight characters, shown as two groups of four."
        label="Code from the terminal"
        required
      >
        <Input
          editable={!busy}
          error={validationError !== null || error != null}
          maxLength={9}
          onChangeText={(value) => {
            setCode(formatPairingCodeInput(value));
            setSubmitted(false);
          }}
          onSubmitEditing={submit}
          placeholder="QZ4K-7HMT"
          purpose="oneTimeCode"
          returnKeyType="go"
          style={styles.input}
          value={code}
        />
      </Field>

      <PairingWaitingEscape onEscape={onBack} />

      <View style={styles.actions}>
        <Button onPress={onBack} variant="outline">
          Back
        </Button>
        <Button loading={busy} onPress={submit} style={styles.submit}>
          {busy ? "Checking…" : "Look up host"}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    gap: spacing[2],
  },
  container: {
    gap: spacing[6],
  },
  heading: {
    gap: spacing[2],
  },
  input: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xl,
    letterSpacing: spacing[1],
    textAlign: "center",
  },
  submit: {
    flex: 1,
  },
});
