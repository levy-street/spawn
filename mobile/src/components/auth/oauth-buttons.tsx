import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { AuthAction } from "@/components/auth/auth-actions";
import { authGutter } from "@/components/auth/auth-shell";
import { ProviderMark } from "@/components/auth/provider-mark";
import { Text } from "@/components/ui/text";
import type { AuthProviderOut, ProviderId } from "@/data/api/schemas/auth";
import { useOAuthSignInMutation } from "@/data/queries/auth";
import { isAppleSignInAvailable } from "@/lib/apple-auth";
import { borderWidth, spacing, useTheme } from "@/theme";

export interface OAuthButtonsProps {
  loading?: boolean;
  providers: readonly AuthProviderOut[];
  /**
   * Carried through the provider round trip so a closed deployment can admit
   * the account at the callback. There is no form between this button and the
   * account being created, so this is the only chance to supply one.
   */
  invite?: string | null;
}

/**
 * The alternate ways in, set below the email path rather than above it: email is
 * the route that works in every build, and burying it under a stack of
 * third-party plates is what made this screen read as a web form.
 */
export function OAuthButtons({ invite = null, loading = false, providers }: OAuthButtonsProps) {
  const theme = useTheme();
  const signIn = useOAuthSignInMutation();
  const [appleReady, setAppleReady] = useState(false);

  useEffect(() => {
    let live = true;
    void isAppleSignInAvailable().then((available) => {
      if (live) setAppleReady(available);
    });
    return () => {
      live = false;
    };
  }, []);

  // Apple is offered wherever the device can show the sheet, whether or not the
  // server lists it: on iOS the button is the native one and needs no redirect.
  const listed = providers.filter((provider) => provider.id !== "apple");
  const apple = providers.find((provider) => provider.id === "apple");
  const showApple = appleReady && apple !== undefined;

  if (loading || (listed.length === 0 && !showApple)) return null;

  const pending = signIn.isPending;
  const press = (id: ProviderId) => () => {
    signIn.reset();
    signIn.mutate({ provider: id, invite });
  };

  return (
    <View style={styles.container}>
      <View accessibilityElementsHidden style={styles.dividerRow}>
        <View style={[styles.line, { backgroundColor: theme.colors.border }]} />
        <Text color="mutedForeground" variant="sigilLabel">
          Or
        </Text>
        <View style={[styles.line, { backgroundColor: theme.colors.border }]} />
      </View>
      <View style={styles.buttons}>
        {showApple ? (
          <AuthAction
            accessibilityLabel="Sign in with Apple"
            disabled={pending}
            icon={<ProviderMark provider="apple" />}
            key="apple"
            label="Sign in with Apple"
            onPress={press("apple")}
            tone="quiet"
          />
        ) : null}
        {listed.map((provider) => (
          <AuthAction
            accessibilityLabel={`Continue with ${provider.name}`}
            disabled={pending}
            icon={<ProviderMark provider={provider.id} />}
            key={provider.id}
            label={`Continue with ${provider.name}`}
            onPress={press(provider.id)}
            tone="quiet"
          />
        ))}
        {signIn.isError ? (
          <Text color="destructive" style={styles.reason} variant="caption">
            {signIn.error.message}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  buttons: {
    gap: spacing[3],
  },
  container: {
    gap: spacing[5],
    paddingHorizontal: authGutter,
  },
  dividerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[4],
  },
  line: {
    flex: 1,
    height: borderWidth.hairline,
  },
  reason: {
    textAlign: "center",
  },
});
