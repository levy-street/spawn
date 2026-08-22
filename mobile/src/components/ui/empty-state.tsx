import type { ReactElement, ReactNode } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { Icon, type IconName } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { borderWidth, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

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
    return <Icon color="mutedForeground" name={icon} size={sizing.emptyState.icon} />;
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
    <View
      style={[
        styles.container,
        style,
        {
          backgroundColor: theme.colors.card,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          borderWidth: borderWidth.hairline,
          minHeight: sizing.emptyState.containerMinHeight,
          padding: sizing.emptyState.containerPadding,
        },
      ]}
      testID={testID}
    >
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
        <Text style={[styles.centeredText, styles.title]} variant="label" weight="semibold">
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
    alignSelf: "stretch",
    marginTop: sizing.emptyState.actionTopGap,
  },
  centeredText: {
    textAlign: "center",
  },
  container: {
    alignItems: "center",
    alignSelf: "stretch",
    gap: sizing.emptyState.contentGap,
    justifyContent: "center",
  },
  copy: {
    gap: sizing.emptyState.copyGap,
  },
  description: {
    maxWidth: sizing.emptyState.bodyMaxWidth,
  },
  descriptionText: {
    fontSize: sizing.type.emptyStateBody.fontSize,
    lineHeight: sizing.type.emptyStateBody.lineHeight,
  },
  iconPlate: {
    alignItems: "center",
    borderWidth: borderWidth.hairline,
    height: sizing.emptyState.iconPlate,
    justifyContent: "center",
    width: sizing.emptyState.iconPlate,
  },
  title: {
    fontSize: sizing.type.emptyStateTitle.fontSize,
    lineHeight: sizing.type.emptyStateTitle.lineHeight,
  },
});
