import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { StyleSheet, type TextInput, View } from "react-native";
import { AuthAction } from "@/components/auth/auth-actions";
import { AuthField, AuthInput, authFormGap } from "@/components/auth/auth-field";
import { AuthMessage } from "@/components/auth/auth-message";
import { useAuthBack } from "@/components/auth/auth-navigation";
import { AuthBlock, AuthShell } from "@/components/auth/auth-shell";
import { Text } from "@/components/ui/text";
import { ApiError } from "@/data/api/client";
import { usePasswordResetConfirmMutation } from "@/data/queries/auth";
import { matchingConfirmation, PASSWORD_MAX_LENGTH, validateResetPassword } from "@/lib/validation";

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
  const goBack = useAuthBack();
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

  if (token === undefined) {
    return (
      <AuthShell
        description="Reset links carry a one-time token. This one arrived without it."
        onBack={goBack}
        title="This link is incomplete"
      >
        <AuthMessage tone="error">This link is missing its token. Request a new one.</AuthMessage>
        <AuthBlock>
          <AuthAction
            label="Request a reset link"
            onPress={() => router.replace("/forgot-password")}
          />
        </AuthBlock>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      description="Use a unique password with at least 12 characters."
      onBack={goBack}
      title="Choose a new password"
    >
      <View style={styles.form}>
        <AuthField
          error={passwordError}
          hint="At least 12 characters."
          label="New password"
          required
        >
          <AuthInput
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
        </AuthField>
        <AuthField error={confirmationError} label="Confirm new password" required>
          <AuthInput
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
        </AuthField>
      </View>
      {requestError !== null ? <AuthMessage tone="error">{requestError}</AuthMessage> : null}
      <AuthBlock>
        <AuthAction
          disabled={!valid}
          label={resetPassword.isPending ? "Resetting…" : "Set new password"}
          loading={resetPassword.isPending}
          onPress={() => {
            void submit();
          }}
        />
        <Text color="mutedForeground" style={styles.note} variant="caption">
          Every device currently signed in to this account will be signed out.
        </Text>
      </AuthBlock>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: authFormGap,
  },
  note: {
    marginTop: authFormGap / 2,
    textAlign: "center",
  },
});
