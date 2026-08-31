import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { SETTINGS_PANELS, type SettingsPanelKey } from "@/components/settings/settings-inventory";
import { SettingsLinkRow } from "@/components/settings/settings-row";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { useMeSettingsQuery } from "@/data/queries/settings";
import { billingActive } from "@/data/selectors/billing";
import { spacing } from "@/theme";

/**
 * How the inventory reads as a list. The panels keep their inventory order; the
 * groups only say where one subject ends and the next begins, so a reader scans
 * headings rather than nine identical rows.
 */
const PANEL_GROUPS = [
  { title: "General", keys: ["account", "subscription", "appearance", "notifications"] },
  // Machines are the Legion tab's, not a setting: connecting, renaming and
  // removing one all happen there, so Settings keeps to what runs on them.
  { title: "Agents", keys: ["agents", "skills", "templates"] },
  { title: "Devices & trust", keys: ["devices", "trust"] },
] as const satisfies readonly { title: string; keys: readonly SettingsPanelKey[] }[];

const PANELS_BY_KEY = new Map(SETTINGS_PANELS.map((panel) => [panel.key, panel]));

export function SettingsRoot(): React.JSX.Element {
  const router = useRouter();
  const me = useMeSettingsQuery();
  const user = me.data?.user;
  // Billing off means no billing surface at all — the row goes with it, exactly
  // as `is_admin` decides the Admin row below. The account's plan block is null
  // on a deployment without billing, which is the same condition the server
  // enforces, so a row is never drawn for a panel with nothing behind it.
  const showsBilling = billingActive(user?.billing);

  return (
    <SettingsScreen root testID="settings-root" title="Settings">
      <View style={styles.groups}>
        {PANEL_GROUPS.map((group) => (
          <SettingsSection
            key={group.title}
            testID={`settings-group-${group.title.toLowerCase()}`}
            title={group.title}
          >
            {group.keys.map((key) => {
              const panel = PANELS_BY_KEY.get(key);
              if (panel === undefined) return null;
              if (panel.key === "subscription" && !showsBilling) return null;
              return (
                <SettingsLinkRow
                  icon={panel.icon}
                  key={panel.key}
                  label={panel.label}
                  onPress={() => router.push(panel.route)}
                  testID={`settings-panel-${panel.key}`}
                />
              );
            })}
          </SettingsSection>
        ))}

        <SettingsSection testID="settings-group-support" title="Connection & support">
          <SettingsLinkRow
            icon="Network"
            label="Server"
            onPress={() => router.push("/settings/server")}
            testID="settings-panel-server"
          />
          <SettingsLinkRow
            icon="ShieldCheck"
            label="About & security"
            onPress={() => router.push("/settings/about")}
            testID="settings-panel-about"
          />
        </SettingsSection>

        {/* Admin is an ordinary row rather than a header icon: it is a place you
            go, not an action on this screen, and only an admin account has it. */}
        {user?.is_admin ? (
          <SettingsSection testID="settings-group-admin" title="Administration">
            <SettingsLinkRow
              icon="Settings2"
              label="Admin"
              onPress={() => router.push("/admin")}
              testID="settings-panel-admin"
            />
          </SettingsSection>
        ) : null}
      </View>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  groups: {
    gap: spacing[6],
  },
});
