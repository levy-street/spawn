import { StyleSheet, View } from "react-native";
import {
  HOST_IDENTITY_CONFLICT_TITLE,
  SIGNED_RTC_REFUSAL_DETAIL,
  SIGNED_RTC_REFUSAL_NEXT_STEP,
} from "@/components/hosts/host-trust-copy";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { spacing, useTheme } from "@/theme";

/**
 * The host answered with a different identity than the one this device
 * approved. The panel's one way out is removal, then a fresh possession from
 * the host's own terminal — which is the re-verification. There is
 * deliberately no "trust the new identity" control: accepting a new key in
 * place is precisely what an impersonator needs.
 */
export function HostIdentityConflict({
  onRemove,
  removing = false,
}: {
  onRemove(): void;
  removing?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Card
      accessibilityRole="alert"
      style={[
        styles.panel,
        { backgroundColor: theme.colors.warningSoft, borderColor: theme.colors.warning },
      ]}
      testID="host-identity-conflict"
      variant="flat"
    >
      <View style={styles.heading}>
        <Icon color="warning" name="ShieldAlert" size={spacing[5]} />
        <Text style={styles.title} variant="label">
          {HOST_IDENTITY_CONFLICT_TITLE}
        </Text>
      </View>
      <Text color="mutedForeground">{SIGNED_RTC_REFUSAL_DETAIL.host_key_substituted}</Text>
      <Text color="mutedForeground">{SIGNED_RTC_REFUSAL_NEXT_STEP.host_key_substituted}</Text>
      <Button
        disabled={removing}
        onPress={onRemove}
        size="sm"
        testID="conflict-remove-host"
        variant="destructive"
      >
        Remove this host
      </Button>
    </Card>
  );
}

const styles = StyleSheet.create({
  heading: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[2],
  },
  panel: {
    alignItems: "flex-start",
    gap: spacing[3],
  },
  title: {
    flex: 1,
  },
});
