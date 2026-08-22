import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { StyleSheet, type TextInput, View } from "react-native";
import { AuthMessage } from "@/components/auth/auth-message";
import { AuthShell } from "@/components/auth/auth-shell";
import { OAuthButtons } from "@/components/auth/oauth-buttons";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
      title="Welcome back"
    >
      <View style={styles.content}>
        <OAuthButtons
          loading={configQuery.isPending}
          providers={configQuery.data?.providers ?? []}
        />
        {configQuery.isError ? (
          <Text accessibilityRole="alert" color="mutedForeground">
            Social sign-in is temporarily unavailable. Email sign-in still works.
          </Text>
        ) : null}
        <View style={styles.form}>
          <Field error={errors.email} label="Email" required>
            <Input
              autoFocus
              editable={!login.isPending}
              error={errors.email !== null}
              nextRef={passwordRef}
              onChangeText={(value) => {
                setEmail(value);
                setRequestError(null);
              }}
              purpose="email"
              returnKeyType="next"
              testID="login-email"
              value={email}
            />
          </Field>
          <View style={styles.passwordGroup}>
            <Field error={errors.password} label="Password" required>
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
            </Field>
            <Button
              accessibilityLabel="Forgot password?"
              onPress={() => router.push("/forgot-password")}
              variant="link"
            >
              Forgot password?
            </Button>
          </View>
          {requestError !== null ? <AuthMessage tone="error">{requestError}</AuthMessage> : null}
          <Button
            accessibilityLabel={login.isPending ? "Signing in…" : "Sign in"}
            loading={login.isPending}
            onPress={() => {
              void submit();
            }}
            size="lg"
          >
            {login.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </View>
        <View style={styles.accountLink}>
          <Button
            accessibilityLabel="Server settings"
            onPress={() => router.push("/server")}
            variant="link"
          >
            Server
          </Button>
        </View>
        <View style={styles.accountLink}>
          <Text color="mutedForeground">No account?</Text>
          <Button
            accessibilityLabel="Create one"
            onPress={() => router.push("/signup")}
            variant="link"
          >
            Create one
          </Button>
        </View>
      </View>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  accountLink: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
  },
  content: {
    gap: spacing[5],
  },
  form: {
    gap: spacing[4],
  },
  passwordGroup: {
    alignItems: "flex-end",
  },
});
