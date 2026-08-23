import { StyleSheet } from "react-native";
import { authGutter } from "@/components/auth/auth-shell";
import { Field, type FieldProps } from "@/components/ui/field";
import { spacing } from "@/theme";

/**
 * A field on the account sheet: the app's own plated control, under the sigil
 * label the press skin gives it. The control is deliberately the standard one —
 * a bespoke field here would make the one screen every account passes through
 * behave unlike everywhere else in the app.
 */
export function AuthField(props: Omit<FieldProps, "variant">) {
  return <Field {...props} style={[styles.field, props.style]} variant="auth" />;
}

/** The rhythm a run of fields is set on. */
export const authFormGap = spacing[5];

const styles = StyleSheet.create({
  field: {
    paddingHorizontal: authGutter,
  },
});
