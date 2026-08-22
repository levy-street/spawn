import { StyleSheet, View } from "react-native";
import { Badge } from "@/components/ui/badge";
import { Divider } from "@/components/ui/divider";
import { Text } from "@/components/ui/text";
import type { SkillOut } from "@/data/api/schemas/skills";
import { borderWidth, spacing, useTheme } from "@/theme";

export function HostSkillsList({ skills }: { skills: readonly SkillOut[] }) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <View style={styles.heading}>
        <Text accessibilityRole="header" variant="label" weight="semibold">
          Skills
        </Text>
        <Text color="mutedForeground" variant="caption">
          {skills.length}
        </Text>
      </View>
      {skills.length === 0 ? (
        <Text color="mutedForeground" variant="body">
          No skills yet.
        </Text>
      ) : (
        <View
          style={[
            styles.rows,
            {
              backgroundColor: theme.colors.card,
              borderColor: theme.colors.border,
              borderRadius: theme.radii.lg,
            },
          ]}
        >
          {skills.map((skill, index) => (
            <View key={skill.id}>
              {index > 0 ? <Divider /> : null}
              <View style={styles.row}>
                <View style={styles.copy}>
                  <View style={styles.titleRow}>
                    <Text variant="label">{skill.name}</Text>
                    {skill.enabled_by_default ? <Badge>default</Badge> : null}
                  </View>
                  {skill.description ? (
                    <Text color="mutedForeground" variant="caption">
                      {skill.description}
                    </Text>
                  ) : null}
                </View>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  copy: {
    flex: 1,
    gap: spacing[1],
  },
  heading: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
  row: {
    flexDirection: "row",
    padding: spacing[4],
  },
  rows: {
    borderWidth: borderWidth.hairline,
  },
  section: {
    gap: spacing[3],
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
});
