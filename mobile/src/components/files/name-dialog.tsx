import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { type PathFlavor, validateLeafName } from "@/components/files/paths";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { spacing } from "@/theme";

export interface NameDialogProps {
  visible: boolean;
  title: string;
  confirmLabel: string;
  initialValue?: string;
  pending?: boolean;
  pathFlavor?: PathFlavor;
  /**
   * The host's refusal of the name last sent. It is shown here, where the name
   * was typed, for as long as the field still says that name.
   */
  error?: string | null;
  onDismiss: () => void;
  onConfirm: (name: string) => void;
}

export function NameDialog({
  visible,
  title,
  confirmLabel,
  initialValue = "",
  pending = false,
  pathFlavor = "posix",
  error: hostError = null,
  onDismiss,
  onConfirm,
}: NameDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const error = validateLeafName(value, pathFlavor);
  const confirmedValue = pathFlavor === "windows" ? value : value.trim();
  useEffect(() => {
    if (!visible) return;
    setValue(initialValue);
    setSubmitted(null);
  }, [initialValue, visible]);
  const submit = () => {
    if (error || pending) return;
    setSubmitted(value);
    onConfirm(confirmedValue);
  };
  const message = error ?? (hostError && submitted === value ? hostError : null);
  return (
    <Dialog
      footer={
        <>
          <Button disabled={pending} onPress={onDismiss} size="sm" variant="outline">
            Cancel
          </Button>
          <Button disabled={error !== null} loading={pending} onPress={submit} size="sm">
            {confirmLabel}
          </Button>
        </>
      }
      onDismiss={onDismiss}
      size="sm"
      title={title}
      visible={visible}
    >
      <View style={styles.content}>
        <Input
          accessibilityLabel="Name"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          onChangeText={setValue}
          onSubmitEditing={submit}
          placeholder="Name"
          returnKeyType="done"
          value={value}
        />
        {message ? (
          <Text accessibilityLiveRegion="polite" color="destructive" variant="caption">
            {message}
          </Text>
        ) : null}
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing[2],
    padding: spacing[4],
  },
});
