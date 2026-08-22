import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { StyleSheet, type TextInput, View } from "react-native";
import { AuthMessage } from "@/components/auth/auth-message";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { ApiError } from "@/data/api/client";
import { usePasswordResetConfirmMutation } from "@/data/queries/auth";
import { matchingConfirmation, PASSWORD_MAX_LENGTH, validateResetPassword } from "@/lib/validation";
import { spacing } from "@/theme";

export interface ResetPasswordErrors {
  confirm: string | null;
  password: string | null;
}

export function validateResetPasswordForm(
  password: string,
  confirmation: string,
): ResetPasswordErrors {
  return {
    password: validateResetPassword(password),
    confirm: matchingConfirmation(password)(confirmation),
  };
}

export function ResetPasswordScreen({ token }: { token?: string }) {
  const router = useRouter();
  const resetPassword = usePasswordResetConfirmMutation();
  const confirmRef = useRef<TextInput>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);

  const currentErrors = validateResetPasswordForm(password, confirmation);
  const passwordError = password.length === 0 ? null : currentErrors.password;
  const confirmationError = confirmation.length === 0 ? null : currentErrors.confirm;
  const valid = currentErrors.password === null && currentErrors.confirm === null;

  const submit = async () => {
    if (!valid || token === undefined) return;
    setRequestError(null);
    try {
      await resetPassword.mutateAsync({ token, new_password: password });
      router.replace("/");
    } catch (error) {
      setRequestError(error instanceof ApiError ? error.message : "Could not reset your password");
    }
  };

  return (
    <AuthShell
      description="Use a unique password with at least 12 characters."
      title="Choose a new password"
    >
      {token === undefined ? (
        <View style={styles.content}>
          <AuthMessage tone="error">This link is missing its token. Request a new one.</AuthMessage>
          <Button
            accessibilityLabel="Request a reset link"
            onPress={() => router.replace("/forgot-password")}
            size="lg"
          >
            Request a reset link
          </Button>
        </View>
      ) : (
        <View style={styles.content}>
          <Field error={passwordError} hint="At least 12 characters." label="New password" required>
            <Input
              autoFocus
              editable={!resetPassword.isPending}
              error={passwordError !== null}
              maxLength={PASSWORD_MAX_LENGTH}
              nextRef={confirmRef}
              onChangeText={(value) => {
                setPassword(value);
                setRequestError(null);
              }}
              purpose="newPassword"
              returnKeyType="next"
              testID="reset-new-password"
              value={password}
            />
          </Field>
          <Field error={confirmationError} label="Confirm new password" required>
            <Input
              editable={!resetPassword.isPending}
              error={confirmationError !== null}
              maxLength={PASSWORD_MAX_LENGTH}
              onChangeText={(value) => {
                setConfirmation(value);
                setRequestError(null);
              }}
              onSubmitEditing={() => {
                void submit();
              }}
              purpose="newPassword"
              ref={confirmRef}
              returnKeyType="go"
              testID="reset-confirm-password"
              value={confirmation}
            />
          </Field>
          {requestError !== null ? <AuthMessage tone="error">{requestError}</AuthMessage> : null}
          <Text color="mutedForeground" variant="caption">
            Every device currently signed in to this account will be signed out.
          </Text>
          <Button
            accessibilityLabel={resetPassword.isPending ? "Resetting…" : "Set new password"}
            disabled={!valid}
            loading={resetPassword.isPending}
            onPress={() => {
              void submit();
            }}
            size="lg"
          >
            {resetPassword.isPending ? "Resetting…" : "Set new password"}
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
});
