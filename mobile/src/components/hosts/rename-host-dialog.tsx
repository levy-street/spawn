import { useEffect, useRef, useState } from "react";
import type { TextInput } from "react-native";
import { StyleSheet, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { spacing } from "@/theme";

export interface RenameHostDialogProps {
  currentName: string;
  error?: string | null;
  loading: boolean;
  visible: boolean;
  onCancel(): void;
  onRename(name: string): void;
}

export function RenameHostDialog({
  currentName,
  error,
  loading,
  visible,
  onCancel,
  onRename,
}: RenameHostDialogProps) {
  const [name, setName] = useState(currentName);
  const canceling = useRef(false);
  const submitting = useRef(false);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!visible) return;
    setName(currentName);
    canceling.current = false;
    submitting.current = false;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [currentName, visible]);

  useEffect(() => {
    if (!loading) submitting.current = false;
  }, [loading]);

  const commit = () => {
    if (submitting.current) return;
    const trimmed = name.trim();
    if (!loading && trimmed.length > 0 && trimmed !== currentName) {
      submitting.current = true;
      onRename(trimmed);
    } else if (trimmed === currentName) onCancel();
  };

  return (
    <Dialog
      footer={
        <>
          <Button
            onPress={onCancel}
            onPressIn={() => {
              canceling.current = true;
            }}
            size="sm"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={name.trim().length === 0 || name.trim() === currentName}
            loading={loading}
            onPress={commit}
            size="sm"
          >
            Save
          </Button>
        </>
      }
      onDismiss={onCancel}
      showCloseButton={false}
      size="sm"
      title="Host name"
      visible={visible}
    >
      <View style={styles.content}>
        <Input
          accessibilityLabel="Host name"
          error={Boolean(error)}
          maxLength={128}
          onBlur={() => {
            if (!canceling.current) commit();
          }}
          onChangeText={setName}
          onSubmitEditing={commit}
          purpose="name"
          ref={inputRef}
          returnKeyType="done"
          selectTextOnFocus
          value={name}
        />
        {error ? (
          <Text accessibilityRole="alert" color="destructive" variant="caption">
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
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
});
