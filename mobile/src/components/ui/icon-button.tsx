import { StyleSheet } from "react-native";
import {
  Button,
  type ButtonProps,
  type ButtonSize,
  buttonContentColor,
} from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { spacing } from "@/theme";

export type IconButtonSize = Exclude<ButtonSize, "icon">;

export interface IconButtonProps
  extends Omit<ButtonProps, "accessibilityLabel" | "children" | "size"> {
  accessibilityLabel: string;
  icon: IconName;
  size?: IconButtonSize;
}

const ICON_SIZE = {
  default: spacing[4],
  sm: spacing[4],
  lg: spacing[5],
} as const;

const CONTROL_SIZE = {
  default: spacing[10],
  sm: spacing[9],
  lg: spacing[11],
} as const;

export function IconButton({
  accessibilityLabel,
  icon,
  size = "default",
  style,
  variant = "ghost",
  ...props
}: IconButtonProps) {
  return (
    <Button
      {...props}
      accessibilityLabel={accessibilityLabel}
      size={size === "default" ? "icon" : size}
      style={[styles.square, { height: CONTROL_SIZE[size], width: CONTROL_SIZE[size] }, style]}
      variant={variant}
    >
      <Icon color={buttonContentColor(variant)} name={icon} size={ICON_SIZE[size]} />
    </Button>
  );
}

const styles = StyleSheet.create({
  square: {
    paddingHorizontal: spacing[0],
  },
});
