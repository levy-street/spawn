import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { StyleSheet, type TextInput, View } from "react-native";
import { AuthAction, AuthLink } from "@/components/auth/auth-actions";
import { AuthField, authFormGap } from "@/components/auth/auth-field";
import { AuthMessage } from "@/components/auth/auth-message";
import { useAuthBack } from "@/components/auth/auth-navigation";
import { AuthBlock, AuthShell, authGutter } from "@/components/auth/auth-shell";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/data/api/client";
import { useLoginMutation } from "@/data/queries/auth";
import { validateEmail, validateRequired } from "@/lib/validation";
import { spacing } from "@/theme";

export interface LoginErrors {
  email: string | null;
  password: string | null;
}

export function validateLoginForm(email: string, password: string): LoginErrors {
  return {
    email: validateRequired(email) ?? validateEmail(email),
    password: validateRequired(password),
  };
}

/**
 * The email form, as a page of its own pushed over the sign-in screen — the
 * same sheet the sign-up form is printed on, with the same way back. Most
 * people sign in with the account button they signed up with; a two-field form
 * standing above those buttons made every arrival read as a form to fill in.
 */
export function EmailLoginScreen() {
  const router = useRouter();
  const goBack = useAuthBack();
  const login = useLoginMutation();
  const passwordRef = useRef<TextInput>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<LoginErrors>({ email: null, password: null });
  const [requestError, setRequestError] = useState<string | null>(null);

  const submit = async () => {
    const nextErrors = validateLoginForm(email, password);
    setErrors(nextErrors);
    setRequestError(null);
    if (nextErrors.email !== null || nextErrors.password !== null) return;

    try {
      await login.mutateAsync({ email, password });
      router.replace("/");
    } catch (error) {
      setRequestError(error instanceof ApiError ? error.message : "Sign-in failed");
    }
  };

  return (
    <AuthShell
      description="The address you signed up with, and the words that go with it."
      onBack={goBack}
      title="Sign in with email"
    >
      <View style={styles.form}>
        <AuthField error={errors.email} label="Email" required>
          <Input
            editable={!login.isPending}
            error={errors.email !== null}
            nextRef={passwordRef}
            onChangeText={(value) => {
              setEmail(value);
              setRequestError(null);
            }}
            placeholder="you@example.com"
            purpose="email"
            returnKeyType="next"
            testID="login-email"
            value={email}
          />
        </AuthField>
        <View style={styles.passwordGroup}>
          <AuthField error={errors.password} label="Password" required>
            <Input
              editable={!login.isPending}
              error={errors.password !== null}
              onChangeText={(value) => {
                setPassword(value);
                setRequestError(null);
              }}
              onSubmitEditing={() => {
                void submit();
              }}
              purpose="password"
              ref={passwordRef}
              returnKeyType="go"
              testID="login-password"
              value={password}
            />
          </AuthField>
          <View style={styles.forgotRow}>
            <AuthLink label="Forgot password?" onPress={() => router.push("/forgot-password")} />
          </View>
        </View>
      </View>
      {requestError !== null ? <AuthMessage tone="error">{requestError}</AuthMessage> : null}
      <AuthBlock>
        <AuthAction
          label={login.isPending ? "Signing in…" : "Sign in"}
          loading={login.isPending}
          onPress={() => {
            void submit();
          }}
          testID="login-submit"
        />
      </AuthBlock>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  forgotRow: {
    alignItems: "flex-end",
    paddingHorizontal: authGutter,
  },
  form: {
    gap: authFormGap,
  },
  passwordGroup: {
    gap: spacing[1],
  },
});
