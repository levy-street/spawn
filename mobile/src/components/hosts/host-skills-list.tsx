import { StyleSheet, View } from "react-native";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ListGroup } from "@/components/ui/list-group";
import { ListRow } from "@/components/ui/list-row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import type { SkillOut } from "@/data/api/schemas/skills";
import { spacing } from "@/theme";

export function HostSkillsList({ skills }: { skills: readonly SkillOut[] }) {
  return (
    <View style={styles.section}>
      <SectionHeader
        style={styles.sectionHeader}
        title="Skills"
        trailing={
          <Text color="mutedForeground" variant="caption">
            {skills.length}
          </Text>
        }
      />
      {skills.length === 0 ? (
        <EmptyState icon="Wrench" title="No skills yet." />
      ) : (
        <ListGroup testID="host-skill-rows">
          {skills.map((skill) => (
            <View key={skill.id}>
              <ListRow
                height={skill.description ? "tall" : "regular"}
                shape="fullBleed"
                {...(skill.description ? { subtitle: skill.description } : {})}
                title={skill.name}
                trailing={skill.enabled_by_default ? <Badge>default</Badge> : undefined}
              />
            </View>
          ))}
        </ListGroup>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing[0],
  },
  sectionHeader: {
    paddingHorizontal: spacing[0],
  },
});
