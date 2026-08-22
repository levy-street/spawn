import type { ReactNode } from "react";
import {
  Text as NativeText,
  type TextProps as NativeTextProps,
  type TextStyle,
} from "react-native";

import { type Colors, useTheme } from "@/theme";

export type TextVariant = "title" | "body" | "label" | "caption" | "mono" | "micro";
export type TextColor = keyof Colors;
export type TextWeight = "light" | "normal" | "medium" | "semibold";

export interface TextProps extends NativeTextProps {
  children?: ReactNode;
  color?: TextColor;
  variant?: TextVariant;
  weight?: TextWeight;
}

export function Text({
  color = "foreground",
  style,
  variant = "body",
  weight,
  ...props
}: TextProps) {
  const theme = useTheme();
  const variantStyle: TextStyle = (() => {
    switch (variant) {
      case "title":
        return theme.type.typeStyles.cardTitle;
      case "body":
        return theme.type.typeStyles.uiSm;
      case "label":
        return theme.type.typeStyles.uiSmMedium;
      case "caption":
        return theme.type.typeStyles.uiXs;
      case "mono":
        return theme.type.typeStyles.terminal;
      case "micro":
        return theme.type.typeStyles.micro;
    }
  })();

  return (
    <NativeText
      {...props}
      style={[
        variantStyle,
        { color: theme.colors[color] },
        weight === undefined ? undefined : { fontWeight: theme.type.fontWeight[weight] },
        style,
      ]}
    />
  );
}
