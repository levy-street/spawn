import { useRouter } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";

import { DeviceApprovalCeremony } from "@/components/trust/device-approval-ceremony";
import { Sheet, SheetHeader } from "@/components/ui/sheet";
import { spacing } from "@/theme";
import { sizing } from "@/theme/sizing";

/**
 * The approval ceremony raised over the surface that needs it.
 *
 * A terminal that fails with device_not_trusted used to strand the operator on
 * an error screen whose fix lived three screens away. This raises the ceremony
 * in place — knock sent automatically, watched live — and the approval landing
 * anywhere dismisses it with the connection retrying underneath.
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
  const router = useRouter();
  return (
    <Sheet onDismiss={onDismiss} testID="device-approval-overlay" visible={visible}>
      <SheetHeader title="Approve this device" />
      <ScrollView contentContainerStyle={styles.content}>
        <DeviceApprovalCeremony
          hostId={hostId}
          onNavigateToPairing={() => router.push("/onboarding/host")}
          onRequestClose={onDismiss}
        />
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: sizing.screen.gutter,
    paddingTop: spacing[2],
  },
});
