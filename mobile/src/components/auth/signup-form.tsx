import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { StyleSheet, type TextInput, View } from "react-native";
import { AuthAction, AuthLink, authFooterRow } from "@/components/auth/auth-actions";
import { AuthField, authFormGap } from "@/components/auth/auth-field";
import { AuthMessage } from "@/components/auth/auth-message";
import { useAuthBack } from "@/components/auth/auth-navigation";
import { AuthBlock, AuthShell } from "@/components/auth/auth-shell";
import { OAuthButtons } from "@/components/auth/oauth-buttons";
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
import { fontFamily, fontSize, letterSpacing, spacing } from "@/theme";

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
    <>
      <View style={styles.form}>
        <AuthField error={errors.email} label="Email" required>
          <Input
            editable={!signup.isPending}
            error={errors.email !== null}
            nextRef={passwordRef}
            onChangeText={(value) => {
              setEmail(value);
              setRequestError(null);
            }}
            placeholder="you@example.com"
            purpose="email"
            returnKeyType="next"
            testID="signup-email"
            value={email}
          />
        </AuthField>
        <AuthField
          error={errors.password}
          hint="Use at least 8 characters."
          label="Password"
          required
        >
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
            testID="signup-password"
            value={password}
          />
        </AuthField>
        {config.invite_only ? (
          <AuthField error={errors.invite} label="Invite code" required>
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
              placeholder="————————"
              purpose="plain"
              ref={inviteRef}
              returnKeyType="go"
              style={styles.inviteInput}
              testID="signup-invite"
              value={invite}
            />
          </AuthField>
        ) : null}
      </View>
      {requestError !== null ? <AuthMessage tone="error">{requestError}</AuthMessage> : null}
      <AuthBlock>
        <AuthAction
          label={signup.isPending ? "Creating account…" : "Create account"}
          loading={signup.isPending}
          onPress={() => {
            void submit();
          }}
        />
      </AuthBlock>
      <OAuthButtons divider providers={config.providers} />
    </>
  );
}

function SignupLoading({ onBack }: { onBack: () => void }) {
  return (
    <AuthShell onBack={onBack} title="Sign the pact">
      <View style={styles.loading}>
        <Spinner label="Loading signup" size={spacing[5]} />
      </View>
    </AuthShell>
  );
}

export function SignupScreen({ invite }: { invite?: string }) {
  const router = useRouter();
  const goBack = useAuthBack();
  const configQuery = useAuthConfigQuery();

  if (configQuery.isPending) return <SignupLoading onBack={goBack} />;
  if (configQuery.isError || configQuery.data === undefined) {
    return (
      <AuthShell
        description="The server never answered with its signup terms."
        onBack={goBack}
        title="No answer"
      >
        <AuthBlock>
          <AuthAction
            label="Try again"
            onPress={() => {
              void configQuery.refetch();
            }}
          />
        </AuthBlock>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      description="An account first. Then you bind the machine your daemons will run on."
      footer={
        <View style={authFooterRow}>
          <Text color="mutedForeground" variant="sigilLabel">
            Already have an account?
          </Text>
          <AuthLink emphasis label="Log in" onPress={() => router.replace("/login")} />
        </View>
      }
      onBack={goBack}
      title="Sign the pact"
    >
      {invite !== undefined ? (
        <AuthMessage>Your invite holds. Sign below to finish.</AuthMessage>
      ) : null}
      <SignupForm
        config={configQuery.data}
        {...(invite === undefined ? {} : { initialInvite: invite })}
      />
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: authFormGap,
  },
  inviteInput: {
    fontFamily: fontFamily.mono,
    letterSpacing: letterSpacing.sigil10Em * fontSize.seventeen,
    textTransform: "uppercase",
  },
  loading: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: spacing[24],
  },
});
