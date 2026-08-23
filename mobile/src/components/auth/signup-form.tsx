import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { StyleSheet, type TextInput, View } from "react-native";
import { AuthMessage } from "@/components/auth/auth-message";
import { AuthShell } from "@/components/auth/auth-shell";
import { OAuthButtons } from "@/components/auth/oauth-buttons";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { ApiError } from "@/data/api/client";
import type { AuthConfigOut } from "@/data/api/schemas/auth";
import { useAuthConfigQuery, useSignupMutation } from "@/data/queries/auth";
import {
  maxLength,
  PASSWORD_MAX_LENGTH,
  validateEmail,
  validateRequired,
  validateSignupPassword,
} from "@/lib/validation";
import { fontFamily, spacing } from "@/theme";

interface SignupErrors {
  email: string | null;
  invite: string | null;
  password: string | null;
}

export function validateSignupForm(
  email: string,
  password: string,
  invite: string,
  inviteRequired: boolean,
): SignupErrors {
  return {
    email: validateRequired(email) ?? validateEmail(email),
    password: validateSignupPassword(password),
    invite: inviteRequired
      ? (validateRequired(invite) ?? maxLength(PASSWORD_MAX_LENGTH)(invite))
      : null,
  };
}

function SignupForm({ config, initialInvite }: { config: AuthConfigOut; initialInvite?: string }) {
  const router = useRouter();
  const signup = useSignupMutation();
  const passwordRef = useRef<TextInput>(null);
  const inviteRef = useRef<TextInput>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState(initialInvite ?? "");
  const [errors, setErrors] = useState<SignupErrors>({
    email: null,
    invite: null,
    password: null,
  });
  const [requestError, setRequestError] = useState<string | null>(null);

  const submit = async () => {
    const nextErrors = validateSignupForm(email, password, invite, config.invite_only);
    setErrors(nextErrors);
    setRequestError(null);
    if (nextErrors.email !== null || nextErrors.password !== null || nextErrors.invite !== null) {
      return;
    }

    try {
      await signup.mutateAsync({
        email,
        password,
        invite: invite.trim() === "" ? null : invite.trim(),
      });
      router.replace("/");
    } catch (error) {
      setRequestError(error instanceof ApiError ? error.message : "Could not create your account");
    }
  };

  return (
    <View style={styles.content}>
      <OAuthButtons providers={config.providers} />
      <View style={styles.form}>
        <Field error={errors.email} label="Email" required>
          <Input
            autoFocus
            editable={!signup.isPending}
            error={errors.email !== null}
            nextRef={passwordRef}
            onChangeText={(value) => {
              setEmail(value);
              setRequestError(null);
            }}
            purpose="email"
            returnKeyType="next"
            value={email}
          />
        </Field>
        <Field error={errors.password} hint="Use at least 8 characters." label="Password" required>
          <Input
            editable={!signup.isPending}
            error={errors.password !== null}
            {...(config.invite_only ? { nextRef: inviteRef } : {})}
            onChangeText={(value) => {
              setPassword(value);
              setRequestError(null);
            }}
            {...(config.invite_only
              ? {}
              : {
                  onSubmitEditing: () => {
                    void submit();
                  },
                })}
            purpose="newPassword"
            ref={passwordRef}
            returnKeyType={config.invite_only ? "next" : "go"}
            value={password}
          />
        </Field>
        {config.invite_only ? (
          <Field error={errors.invite} label="Invite code" required>
            <Input
              editable={!signup.isPending}
              error={errors.invite !== null}
              maxLength={PASSWORD_MAX_LENGTH}
              onChangeText={(value) => {
                setInvite(value);
                setRequestError(null);
              }}
              onSubmitEditing={() => {
                void submit();
              }}
              purpose="plain"
              ref={inviteRef}
              returnKeyType="go"
              style={styles.inviteInput}
              value={invite}
            />
          </Field>
        ) : null}
        {requestError !== null ? <AuthMessage tone="error">{requestError}</AuthMessage> : null}
        <Button
          accessibilityLabel={signup.isPending ? "Creating account…" : "Create account"}
          loading={signup.isPending}
          onPress={() => {
            void submit();
          }}
          size="lg"
        >
          {signup.isPending ? "Creating account…" : "Create account"}
        </Button>
      </View>
    </View>
  );
}

function SignupLoading() {
  return (
    <AuthShell title="Create your account">
      <View style={styles.loading}>
        <Spinner label="Loading signup" size={spacing[5]} />
      </View>
    </AuthShell>
  );
}

export function SignupScreen({ invite }: { invite?: string }) {
  const router = useRouter();
  const configQuery = useAuthConfigQuery();

  if (configQuery.isPending) return <SignupLoading />;
  if (configQuery.isError || configQuery.data === undefined) {
    return (
      <AuthShell
        description="The server’s signup settings are unavailable."
        title="Couldn’t load signup"
      >
        <Button
          accessibilityLabel="Try again"
          onPress={() => {
            void configQuery.refetch();
          }}
          size="lg"
        >
          Try again
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      description="Start with an account, then connect the machine where your agents work."
      title="Create your account"
    >
      <View style={styles.content}>
        {invite !== undefined ? (
          <AuthMessage>You have an invite. Finish creating your account below.</AuthMessage>
        ) : null}
        <SignupForm
          config={configQuery.data}
          {...(invite === undefined ? {} : { initialInvite: invite })}
        />
        <View style={styles.accountLink}>
          <Text color="mutedForeground">Already have an account?</Text>
          <Button
            accessibilityLabel="Log in"
            onPress={() => router.replace("/login")}
            variant="link"
          >
            Log in
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
  inviteInput: {
    fontFamily: fontFamily.mono,
    textTransform: "uppercase",
  },
  loading: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: spacing[24] + spacing[8],
  },
});
