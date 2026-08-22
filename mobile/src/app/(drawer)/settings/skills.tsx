import { Screen } from "@/components/layout/screen";
import { SkillsPanel } from "@/components/settings/skills-panel";

export default function SkillsSettingsRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <SkillsPanel />
    </Screen>
  );
}
