import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { listErrorCopy } from "@/components/files/errors";
import { type PathFlavor, resolveFolderInput } from "@/components/files/paths";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { spacing } from "@/theme";

export interface GoToFolderDialogProps {
  visible: boolean;
  hostName: string;
  homeDir: string;
  /** The folder on screen, full path: what a relative path is read from. */
  cwd: string;
  /** What the field starts with: the folder on screen, as a person reads it. */
  initialValue: string;
  pathFlavor?: PathFlavor;
  pending?: boolean;
  /** The host's answer when it could not open the folder asked for. */
  error?: string | null;
  onDismiss: () => void;
  /** A path inside home, resolved and normalized; whether it exists is the host's to say. */
  onGo: (path: string) => void;
}

/**
 * Typing a folder rather than tapping down to it: `~/…`, a full path, or one
 * relative to the folder on screen, inside home. The web file browser's
 * editable path bar takes the same input and reads it the same way.
 */
export function GoToFolderDialog({
  visible,
  hostName,
  homeDir,
  cwd,
  initialValue,
  pathFlavor = "posix",
  pending = false,
  error,
  onDismiss,
  onGo,
}: GoToFolderDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [touched, setTouched] = useState(false);
  /** What was last sent, so the host's refusal stays only while the field still says it. */
  const [submitted, setSubmitted] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    setValue(initialValue);
    setTouched(false);
    setSubmitted(null);
  }, [initialValue, visible]);
  const resolved = resolveFolderInput(value, { homeDir, cwd, flavor: pathFlavor });
  const hostError = error && submitted === value ? error : null;
  const inputError =
    resolved.error === "empty"
      ? "Enter a folder."
      : resolved.error === "outside_root"
        ? listErrorCopy("outside_root", hostName)
        : null;
  const message = (touched ? inputError : null) ?? hostError;
  const submit = () => {
    setTouched(true);
    if (resolved.path === undefined || pending) return;
    setSubmitted(value);
    onGo(resolved.path);
  };
  return (
    <Dialog
      description={`A folder inside your home folder on ${hostName}. Start with ~ for home.`}
      footer={
        <>
          <Button disabled={pending} onPress={onDismiss} size="sm" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={resolved.path === undefined}
            loading={pending}
            onPress={submit}
            size="sm"
          >
            Go
          </Button>
        </>
      }
      onDismiss={onDismiss}
      size="sm"
      title="Go to folder"
      visible={visible}
    >
      <View style={styles.content}>
        <Input
          accessibilityLabel="Folder"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          onChangeText={(next) => {
            setValue(next);
            setTouched(true);
          }}
          onSubmitEditing={submit}
          placeholder={pathFlavor === "windows" ? "~\\Documents" : "~/Documents"}
          purpose="path"
          returnKeyType="go"
          value={value}
        />
        {message ? (
          <Text color="destructive" variant="caption">
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
