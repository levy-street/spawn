import { type Href, useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { Screen } from "@/components/layout/screen";
import { SETTINGS_PANELS } from "@/components/settings/settings-inventory";
import { SettingsLinkRow } from "@/components/settings/settings-row";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Monogram } from "@/components/ui/monogram";
import { Text } from "@/components/ui/text";
import { useMeSettingsQuery } from "@/data/queries/settings";
import { borderWidth, spacing, useTheme } from "@/theme";

export default function SettingsIndexRoute(): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  const me = useMeSettingsQuery();
  const user = me.data?.user;

  return (
    <Screen padded={false}>
      <SettingsScreen
        description="Manage your account, appearance, notifications, hosts, agents, skills, browser devices, and device trust."
        testID="settings-root"
        title="Settings"
      >
        {user ? (
          <View
            style={[
              styles.profile,
              { backgroundColor: theme.colors.card, borderColor: theme.colors.border },
            ]}
          >
            <Monogram seed={user.email} />
            <View style={styles.profileCopy}>
              <Text numberOfLines={1} variant="label">
                {user.email}
              </Text>
              <View style={styles.badges}>
                <Badge variant={user.email_verified_at ? "success" : "warning"}>
                  {user.email_verified_at ? "verified" : "unverified"}
                </Badge>
                {user.is_admin ? <Badge variant="outline">admin</Badge> : null}
              </View>
            </View>
            <Button
              accessibilityLabel="Open profile"
              onPress={() => router.push("/settings/profile")}
              size="sm"
              variant="outline"
            >
              Profile
            </Button>
          </View>
        ) : null}

        <SettingsSection>
          {SETTINGS_PANELS.map((panel) => (
            <SettingsLinkRow
              icon={panel.icon}
              key={panel.key}
              label={panel.label}
              onPress={() => router.push(`/settings/${panel.key}` as Href)}
              testID={`settings-panel-${panel.key}`}
            />
          ))}
        </SettingsSection>

        <SettingsSection title="Connectivity & support">
          <SettingsLinkRow
            hint="Connection URL and health check"
            icon="Network"
            label="Server"
            onPress={() => router.push("/settings/server")}
            testID="settings-panel-server"
          />
          <SettingsLinkRow
            hint="Version, installation, security, source, and legal information"
            icon="ShieldCheck"
            label="About & security"
            onPress={() => router.push("/settings/about")}
            testID="settings-panel-about"
          />
        </SettingsSection>
      </SettingsScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  badges: {
    flexDirection: "row",
    gap: spacing[1],
  },
  profile: {
    alignItems: "center",
    borderRadius: spacing[2.5],
    borderWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: spacing[3],
    padding: spacing[3],
  },
  profileCopy: {
    flex: 1,
    gap: spacing[1],
    minWidth: 0,
  },
});
