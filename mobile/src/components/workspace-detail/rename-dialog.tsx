import { useEffect, useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTheme } from "@/theme";

export interface RenameDialogProps {
  visible: boolean;
  title: string;
  initialValue: string;
  maxLength: number;
  loading: boolean;
  allowEmpty?: boolean;
  onDismiss: () => void;
  onSubmit: (value: string) => void;
}

export function RenameDialog({
  visible,
  title,
  initialValue,
  maxLength,
  loading,
  allowEmpty = false,
  onDismiss,
  onSubmit,
}: RenameDialogProps) {
  const theme = useTheme();
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [initialValue, visible]);

  return (
    <Dialog
      footer={
        <>
          <Button disabled={loading} onPress={onDismiss} size="sm" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!allowEmpty && value.trim().length === 0}
            loading={loading}
            onPress={() => onSubmit(value.trim())}
            size="sm"
          >
            Save
          </Button>
        </>
      }
      onDismiss={onDismiss}
      showCloseButton={false}
      size="sm"
      title={title}
      visible={visible}
    >
      <View style={{ paddingHorizontal: theme.space(4), paddingVertical: theme.space(2) }}>
        <Input
          accessibilityLabel={title}
          autoFocus
          maxLength={maxLength}
          onChangeText={setValue}
          onSubmitEditing={() => {
            if (allowEmpty || value.trim()) onSubmit(value.trim());
          }}
          purpose="name"
          selectTextOnFocus
          testID="rename-input"
          value={value}
        />
      </View>
    </Dialog>
  );
}
