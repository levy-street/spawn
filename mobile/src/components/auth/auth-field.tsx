import { forwardRef } from "react";
import { StyleSheet, type TextInput } from "react-native";
import { authGutter } from "@/components/auth/auth-shell";
import { Field, type FieldProps } from "@/components/ui/field";
import { Input, type InputProps } from "@/components/ui/input";
import { spacing } from "@/theme";

/**
 * A field on the press sheet: a sigil label, the value struck straight onto the
 * plate, and a rule under it. Nothing draws a box, so a stack of these reads as
 * one printed form rather than as a column of containers.
 */
export function AuthField(props: Omit<FieldProps, "variant">) {
  return <Field {...props} style={[styles.field, props.style]} variant="auth" />;
}

/**
 * The ruled control itself. Its rule breaks the sheet's margin on both sides so
 * the line runs the full width of the plate while the value it underlines stays
 * ranged with everything else.
 */
export const AuthInput = forwardRef<TextInput, Omit<InputProps, "variant">>(function AuthInput(
  { containerStyle, ...props },
  ref,
) {
  return (
    <Input {...props} containerStyle={[styles.bleed, containerStyle]} ref={ref} variant="rule" />
  );
});

/** The rhythm a run of fields is set on. */
export const authFormGap = spacing[6];

const styles = StyleSheet.create({
  bleed: {
    marginHorizontal: -authGutter,
    paddingHorizontal: authGutter,
    width: "auto",
  },
  field: {
    paddingHorizontal: authGutter,
  },
});
