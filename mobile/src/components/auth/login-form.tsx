import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { StyleSheet, type TextInput, View } from "react-native";
import { AuthAction, AuthLink, authFooterRow } from "@/components/auth/auth-actions";
import { AuthField, AuthInput, authFormGap } from "@/components/auth/auth-field";
import { AuthMessage } from "@/components/auth/auth-message";
import { AuthBlock, AuthShell, authGutter } from "@/components/auth/auth-shell";
import { OAuthButtons } from "@/components/auth/oauth-buttons";
import { Text } from "@/components/ui/text";
import { ApiError } from "@/data/api/client";
import { useAuthConfigQuery, useLoginMutation } from "@/data/queries/auth";
import { validateEmail, validateRequired } from "@/lib/validation";
import { spacing } from "@/theme";

interface LoginErrors {
  email: string | null;
  password: string | null;
}

export function validateLoginForm(email: string, password: string): LoginErrors {
  return {
    email: validateRequired(email) ?? validateEmail(email),
    password: validateRequired(password),
  };
}

export function LoginScreen() {
  const router = useRouter();
  const configQuery = useAuthConfigQuery();
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
      setRequestError(error instanceof ApiError ? error.message : "Login failed");
    }
  };

  return (
    <AuthShell
      description="Sign in to reach the shells running across your machines."
      footer={
        <View style={styles.colophon}>
          <View style={authFooterRow}>
            <Text color="mutedForeground" variant="sigilLabel">
              No account?
            </Text>
            <AuthLink emphasis label="Create one" onPress={() => router.push("/signup")} />
          </View>
          <View style={authFooterRow}>
            <AuthLink
              accessibilityLabel="Server settings"
              label="Server"
              onPress={() => router.push("/server")}
              testID="login-server"
            />
          </View>
        </View>
      }
      title="Welcome back"
    >
      <View style={styles.form}>
        <AuthField error={errors.email} label="Email" required>
          <AuthInput
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
            <AuthInput
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
        />
      </AuthBlock>
      {configQuery.isError ? (
        <AuthBlock>
          <Text accessibilityRole="alert" color="mutedForeground" variant="caption">
            Social sign-in is temporarily unavailable. Email sign-in still works.
          </Text>
        </AuthBlock>
      ) : null}
      <OAuthButtons loading={configQuery.isPending} providers={configQuery.data?.providers ?? []} />
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  colophon: {
    gap: spacing[1],
  },
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
