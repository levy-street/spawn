import type { PropsWithChildren } from "react";
import { type StyleProp, StyleSheet, View, type ViewProps, type ViewStyle } from "react-native";

import { Text, type TextProps } from "@/components/ui/text";
import { borderWidth, shadow, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export type CardVariant = "elevated" | "flat";

export interface CardProps extends PropsWithChildren<Omit<ViewProps, "style">> {
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  variant?: CardVariant;
}

export function Card({
  children,
  padded = true,
  style,
  variant = "elevated",
  ...props
}: CardProps) {
  const theme = useTheme();

  return (
    <View
      {...props}
      style={[
        styles.base,
        padded && styles.padded,
        {
          backgroundColor: theme.colors.card,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
        },
        variant === "elevated" && styles.elevated,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export interface CardSectionProps extends Omit<ViewProps, "style"> {
  style?: StyleProp<ViewStyle>;
}

export function CardHeader({ style, ...props }: CardSectionProps): React.JSX.Element {
  return <View {...props} style={[styles.header, style]} />;
}

export type CardTitleProps = Omit<TextProps, "variant">;

export function CardTitle({ color = "cardForeground", ...props }: CardTitleProps) {
  return <Text {...props} color={color} style={[styles.title, props.style]} variant="title" />;
}

export type CardDescriptionProps = Omit<TextProps, "variant">;

export function CardDescription({ color = "mutedForeground", ...props }: CardDescriptionProps) {
  return <Text {...props} color={color} style={[styles.description, props.style]} variant="body" />;
}

export function CardContent({ style, ...props }: CardSectionProps): React.JSX.Element {
  return <View {...props} style={[styles.content, style]} />;
}

export function CardFooter({ style, ...props }: CardSectionProps): React.JSX.Element {
  return <View {...props} style={[styles.footer, style]} />;
}

const styles = StyleSheet.create({
  base: {
    borderWidth: borderWidth.hairline,
    gap: sizing.card.blockGap,
  },
  elevated: {
    boxShadow: shadow.sm,
  },
  header: {
    gap: sizing.card.copyGap,
  },
  content: {
    gap: sizing.card.blockGap,
  },
  description: {
    fontSize: sizing.type.componentLabel.fontSize,
    lineHeight: sizing.type.componentLabel.lineHeight,
  },
  footer: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.card.footerGap,
    paddingTop: sizing.card.footerTopGap - sizing.card.blockGap,
  },
  padded: {
    padding: sizing.card.padding,
  },
  title: {
    fontSize: sizing.type.cardTitle.fontSize,
    lineHeight: sizing.type.cardTitle.lineHeight,
  },
});
