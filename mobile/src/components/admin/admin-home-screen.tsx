import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { SettingsLinkRow } from "@/components/settings/settings-row";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useMeQuery } from "@/data/queries/auth";
import { spacing } from "@/theme";

export function AdminHomeScreen(): React.JSX.Element {
  const router = useRouter();
  const me = useMeQuery();

  return (
    <SettingsScreen
      description="Deployment invitations, accounts, and email delivery."
      testID="admin-home"
      title="Admin"
    >
      <View style={styles.identity}>
        <Badge variant="outline">admin</Badge>
        <Text color="mutedForeground" numberOfLines={1} variant="caption">
          {me.data?.user.email ?? "Administrator"}
        </Text>
      </View>
      <SettingsSection>
        <SettingsLinkRow
          hint="Create one-use signup links and revoke pending invitations"
          icon="KeyRound"
          label="Invites"
          onPress={() => router.push("/admin/invites")}
        />
        <SettingsLinkRow
          hint="Read-only account and deployment counts"
          icon="UserRound"
          label="Users"
          onPress={() => router.push("/admin/users")}
        />
        <SettingsLinkRow
          hint="Delivery status, test messages, and redacted logs"
          icon="Mail"
          label="Email"
          onPress={() => router.push("/admin/emails")}
        />
      </SettingsSection>
      {/* Admin is pushed from Settings, so leaving it is a pop rather than a jump
        to a hardcoded root — the tab bar is what owns landing on Settings. */}
      <Button
        disabled={!router.canGoBack()}
        onPress={() => router.back()}
        variant="outline"
      >
        Exit admin
      </Button>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  identity: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
});
