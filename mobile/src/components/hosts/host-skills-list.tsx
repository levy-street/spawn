import { StyleSheet, View } from "react-native";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow, ListSeparator } from "@/components/ui/list-row";
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
        <Card padded={false} style={styles.rows} variant="flat">
          {skills.map((skill, index) => (
            <View key={skill.id}>
              {index > 0 ? <ListSeparator inset={false} /> : null}
              <ListRow
                height={skill.description ? "tall" : "regular"}
                shape="fullBleed"
                {...(skill.description ? { subtitle: skill.description } : {})}
                title={skill.name}
                trailing={skill.enabled_by_default ? <Badge>default</Badge> : undefined}
              />
            </View>
          ))}
        </Card>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  rows: {
    gap: spacing[0],
    overflow: "hidden",
  },
  section: {
    gap: spacing[3],
  },
  sectionHeader: {
    paddingHorizontal: spacing[0],
  },
});
