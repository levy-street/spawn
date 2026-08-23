import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { validateLeafName } from "@/components/files/paths";
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
  onDismiss: () => void;
  onConfirm: (name: string) => void;
}

export function NameDialog({
  visible,
  title,
  confirmLabel,
  initialValue = "",
  pending = false,
  onDismiss,
  onConfirm,
}: NameDialogProps) {
  const [value, setValue] = useState(initialValue);
  const error = validateLeafName(value);
  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [initialValue, visible]);
  return (
    <Dialog
      footer={
        <>
          <Button disabled={pending} onPress={onDismiss} size="sm" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={error !== null}
            loading={pending}
            onPress={() => onConfirm(value.trim())}
            size="sm"
          >
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
          onSubmitEditing={() => {
            if (!error && !pending) onConfirm(value.trim());
          }}
          placeholder="Name"
          returnKeyType="done"
          value={value}
        />
        {error ? (
          <Text color="destructive" variant="caption">
            {error}
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
