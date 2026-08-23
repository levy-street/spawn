import { StyleSheet } from "react-native";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { borderWidth, spacing, useTheme } from "@/theme";

type ActionOwnProps = Omit<ButtonProps, "children" | "size" | "style" | "variant">;

export interface AuthActionProps extends ActionOwnProps {
  /** Both the struck label and the control's name. Sigil casing is visual only. */
  label: string;
  /**
   * `primary` is the inked slab that commits the screen. `quiet` is the press's
   * own secondary: a hairline plate with bone type, never a filled grey one.
   */
  tone?: "primary" | "quiet";
}

export function AuthAction({ label, tone = "primary", ...props }: AuthActionProps) {
  // A disabled control on the press is an *unstruck* plate — a hairline and ash
  // type — not the bone slab dimmed to a muddy grey. Button dims an inactive
  // control by half, which turns bone into exactly the ash the press wants, so
  // the shape is what changes here and the ink is left to do the rest.
  const theme = useTheme();
  const unstruck = props.disabled === true;
  const hairline = tone === "quiet" || unstruck;
  return (
    <Button
      {...props}
      accessibilityLabel={props.accessibilityLabel ?? label}
      size="lg"
      style={[
        styles.action,
        hairline && {
          borderColor: theme.colors.border,
          borderWidth: borderWidth.hairline,
        },
      ]}
      variant={hairline ? "outline" : "default"}
    >
      <Text color={hairline ? "foreground" : "primaryForeground"} variant="sigilButton">
        {label}
      </Text>
    </Button>
  );
}

export interface AuthLinkProps extends Omit<ButtonProps, "children" | "size" | "variant"> {
  label: string;
  /** Marginalia is ash; the one link that continues the flow is struck in bone. */
  emphasis?: boolean;
}

/** A link set as marginalia — the small print a printed form carries. */
export function AuthLink({ emphasis = false, label, ...props }: AuthLinkProps) {
  return (
    <Button
      {...props}
      accessibilityLabel={props.accessibilityLabel ?? label}
      size="sm"
      style={[styles.link, props.style]}
      variant="link"
    >
      <Text color={emphasis ? "foreground" : "mutedForeground"} variant="sigilLabel">
        {label}
      </Text>
    </Button>
  );
}

const styles = StyleSheet.create({
  action: {
    width: "100%",
  },
  link: {
    paddingHorizontal: 0,
  },
});

/** The row a pair of marginalia links sits on at the foot of the sheet. */
export const authFooterRow = StyleSheet.create({
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    justifyContent: "center",
  },
}).row;
