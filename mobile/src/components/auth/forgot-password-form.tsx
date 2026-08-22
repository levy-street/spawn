import { useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { usePasswordResetRequestMutation } from "@/data/queries/auth";
import { validateEmail, validateRequired } from "@/lib/validation";
import { spacing } from "@/theme";

export function ForgotPasswordScreen() {
  const router = useRouter();
  const requestReset = usePasswordResetRequestMutation();
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    const error = validateRequired(email) ?? validateEmail(email);
    setEmailError(error);
    if (error !== null) return;

    try {
      await requestReset.mutateAsync({ email });
    } catch {
      // Every result becomes the same state so the form cannot disclose account existence.
    } finally {
      setSent(true);
    }
  };

  return (
    <AuthShell
      description={
        sent ? "Check the inbox associated with that address." : "We’ll send a one-time reset link."
      }
      title="Reset your password"
    >
      {sent ? (
        <View style={styles.content}>
          <Text accessibilityRole="summary" style={styles.sentCopy}>
            If an account exists for <Text weight="medium">{email}</Text>, a reset link is on its
            way. It works once and expires in an hour.
          </Text>
          <Text color="mutedForeground" style={styles.sentCopy}>
            Your password stays unchanged until you use the link.
          </Text>
          <Button
            accessibilityLabel="Back to sign in"
            onPress={() => router.replace("/login")}
            size="lg"
            variant="secondary"
          >
            Back to sign in
          </Button>
        </View>
      ) : (
        <View style={styles.content}>
          <Field error={emailError} label="Email" required>
            <Input
              autoFocus
              editable={!requestReset.isPending}
              error={emailError !== null}
              onChangeText={(value) => {
                setEmail(value);
                setEmailError(null);
              }}
              onSubmitEditing={() => {
                void submit();
              }}
              purpose="email"
              returnKeyType="send"
              value={email}
            />
          </Field>
          <Button
            accessibilityLabel={requestReset.isPending ? "Sending…" : "Send reset link"}
            disabled={email === ""}
            loading={requestReset.isPending}
            onPress={() => {
              void submit();
            }}
            size="lg"
          >
            {requestReset.isPending ? "Sending…" : "Send reset link"}
          </Button>
          <Button
            accessibilityLabel="Back to sign in"
            onPress={() => router.replace("/login")}
            variant="link"
          >
            Back to sign in
          </Button>
        </View>
      )}
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing[5],
  },
  sentCopy: {
    lineHeight: spacing[6],
  },
});
