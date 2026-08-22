import { useColorScheme } from "react-native";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Text } from "@/components/ui/text";
import { type ThemeMode, useThemeMode } from "@/theme";

const THEME_OPTIONS = [
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
  { label: "System", value: "system" },
] as const;

export function AppearancePanel(): React.JSX.Element {
  const systemScheme = useColorScheme();
  const { mode, setMode } = useThemeMode();

  return (
    <SettingsScreen
      description="Applies to this device. Terminals restyle in place — you do not lose a session by switching."
      testID="appearance-panel"
      title="Appearance"
    >
      <SettingsSection title="Theme">
        <SegmentedControl<ThemeMode>
          accessibilityLabel="Theme"
          onChange={setMode}
          options={THEME_OPTIONS}
          testID="theme-mode"
          value={mode}
        />
        <Text color="mutedForeground" variant="caption">
          Light: Always light · Dark: Always dark · System: Match this device
        </Text>
        {mode === "system" ? (
          <Text color="mutedForeground" testID="system-theme-state" variant="caption">
            This device currently prefers {systemScheme === "dark" ? "dark" : "light"}.
          </Text>
        ) : null}
      </SettingsSection>
    </SettingsScreen>
  );
}
