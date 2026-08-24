import { ScrollView, StyleSheet } from "react-native";

import { DeviceApprovalBody } from "@/components/trust/device-approval-screen";
import { Sheet, SheetHeader } from "@/components/ui/sheet";
import { spacing } from "@/theme";

/**
 * The approval ceremony raised over the surface that needs it.
 *
 * A terminal that fails with device_not_trusted used to strand the operator on
 * an error screen whose fix lived three screens away. This presents the same
 * ceremony the settings screen owns — knock raised automatically, watched
 * live — without leaving the terminal, and the owner dismisses it (or the
 * approval landing dismisses it) with the connection retrying underneath.
 */
export function DeviceApprovalOverlay({
  hostId,
  visible,
  onDismiss,
}: {
  hostId: string;
  visible: boolean;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <Sheet onDismiss={onDismiss} size="tall" testID="device-approval-overlay" visible={visible}>
      <SheetHeader title="Approve this device" />
      <ScrollView contentContainerStyle={styles.content} style={styles.scroll}>
        <DeviceApprovalBody hostId={hostId} />
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: spacing[6],
  },
  scroll: {
    flex: 1,
  },
});
