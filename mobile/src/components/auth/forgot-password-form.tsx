import { useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { AuthAction, AuthLink } from "@/components/auth/auth-actions";
import { AuthField } from "@/components/auth/auth-field";
import { useAuthBack } from "@/components/auth/auth-navigation";
import { AuthBlock, AuthShell } from "@/components/auth/auth-shell";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { usePasswordResetRequestMutation } from "@/data/queries/auth";
import { validateEmail, validateRequired } from "@/lib/validation";
import { fontFamily, fontSize, spacing } from "@/theme";

export function ForgotPasswordScreen() {
  const router = useRouter();
  const goBack = useAuthBack();
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

  if (sent) {
    return (
      <AuthShell
        description="It burns out in an hour and works only once. Your old word stands until you use it."
        onBack={goBack}
        title="Check your inbox"
      >
        <AuthBlock>
          <Text accessibilityRole="summary" style={styles.copy}>
            If an account exists for{" "}
            <Text style={styles.address} testID="reset-sent-address">
              {email}
            </Text>
            , a reset link is on its way.
          </Text>
        </AuthBlock>
        <AuthBlock>
          <AuthAction
            label="Back to sign in"
            onPress={() => router.replace("/login")}
            tone="quiet"
          />
        </AuthBlock>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      description="Give the address bound to the account. We’ll send a link that works once."
      footer={
        <View style={styles.footer}>
          <AuthLink label="Back to sign in" onPress={() => router.replace("/login")} />
        </View>
      }
      onBack={goBack}
      title="Lost the word"
    >
      <AuthField error={emailError} label="Email" required>
        <Input
          editable={!requestReset.isPending}
          error={emailError !== null}
          onChangeText={(value) => {
            setEmail(value);
            setEmailError(null);
          }}
          onSubmitEditing={() => {
            void submit();
          }}
          placeholder="you@example.com"
          purpose="email"
          returnKeyType="send"
          testID="forgot-email"
          value={email}
        />
      </AuthField>
      <AuthBlock>
        <AuthAction
          disabled={email === ""}
          label={requestReset.isPending ? "Sending…" : "Send reset link"}
          loading={requestReset.isPending}
          onPress={() => {
            void submit();
          }}
        />
      </AuthBlock>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  address: {
    fontFamily: fontFamily.mono,
  },
  copy: {
    fontFamily: fontFamily.grimoireRegular,
    fontSize: fontSize.fifteen,
    lineHeight: spacing[6],
  },
  footer: {
    alignItems: "center",
  },
});
