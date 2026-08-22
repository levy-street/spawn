import type { ReactElement, ReactNode } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { Icon, type IconName } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { borderWidth, spacing, useTheme } from "@/theme";

export interface EmptyStateProps {
  action?: ReactNode;
  description?: ReactNode;
  icon?: IconName | ReactElement;
  iconPlate?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  title: string;
}

function EmptyStateIcon({ icon }: { icon: IconName | ReactElement }) {
  if (typeof icon === "string") {
    return <Icon color="mutedForeground" name={icon} size={spacing[6]} />;
  }
  return icon;
}

export function EmptyState({
  action,
  description,
  icon,
  iconPlate = true,
  style,
  testID,
  title,
}: EmptyStateProps) {
  const theme = useTheme();

  return (
    <View style={[styles.container, style]} testID={testID}>
      {icon !== undefined &&
        (iconPlate ? (
          <View
            accessibilityElementsHidden
            style={[
              styles.iconPlate,
              {
                backgroundColor: theme.colors.muted,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.xl,
              },
            ]}
          >
            <EmptyStateIcon icon={icon} />
          </View>
        ) : (
          <EmptyStateIcon icon={icon} />
        ))}
      <View style={styles.copy}>
        <Text style={styles.centeredText} variant="label" weight="semibold">
          {title}
        </Text>
        {description !== undefined && (
          <View style={styles.description}>
            {typeof description === "string" || typeof description === "number" ? (
              <Text
                color="mutedForeground"
                style={[styles.centeredText, styles.descriptionText]}
                variant="body"
              >
                {description}
              </Text>
            ) : (
              description
            )}
          </View>
        )}
      </View>
      {action !== undefined && <View style={styles.action}>{action}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    marginTop: spacing[2],
  },
  centeredText: {
    textAlign: "center",
  },
  container: {
    alignItems: "center",
    gap: spacing[3],
    justifyContent: "center",
    paddingHorizontal: spacing[6],
    paddingVertical: spacing[12],
  },
  copy: {
    gap: spacing[1],
  },
  description: {
    maxWidth: spacing[24] * 4,
  },
  descriptionText: {
    lineHeight: spacing[6],
  },
  iconPlate: {
    alignItems: "center",
    borderWidth: borderWidth.hairline,
    height: spacing[12],
    justifyContent: "center",
    width: spacing[12],
  },
});
