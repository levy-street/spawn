import type { ReactNode } from "react";
import {
  Text as NativeText,
  type TextProps as NativeTextProps,
  type TextStyle,
} from "react-native";

import { type Colors, useTheme } from "@/theme";

export type TextVariant =
  | "title"
  | "body"
  | "label"
  | "caption"
  | "mono"
  | "micro"
  | "uiBase"
  | "uiSmSemibold"
  | "uiLg"
  | "uiXl"
  | "sigilLabel"
  | "sigilButton"
  | "grimoireBody"
  | "grimoireBodyLoose";
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
      case "uiBase":
        return theme.type.typeStyles.uiBase;
      case "uiSmSemibold":
        return theme.type.typeStyles.uiSmSemibold;
      case "uiLg":
        return theme.type.typeStyles.uiLg;
      case "uiXl":
        return theme.type.typeStyles.uiXl;
      case "sigilLabel":
        return theme.type.typeStyles.sigilLabel;
      case "sigilButton":
        return theme.type.typeStyles.sigilButton;
      case "grimoireBody":
        return theme.type.typeStyles.grimoireBody;
      case "grimoireBodyLoose":
        return theme.type.typeStyles.grimoireBodyLoose;
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
