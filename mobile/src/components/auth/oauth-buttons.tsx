import { type ReactNode, useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { authGutter } from "@/components/auth/auth-shell";
import { ProviderMark } from "@/components/auth/provider-mark";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import type { AuthProviderOut, ProviderId } from "@/data/api/schemas/auth";
import { useOAuthSignInMutation } from "@/data/queries/auth";
import { isAppleSignInAvailable } from "@/lib/apple-auth";
import { borderWidth, opacity, spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

/**
 * `ink` is the filled slab — the theme's primary, so it is white on a dark
 * ground and black on a light one — for the one way in a screen leads with.
 * `plate` is the bordered plate Google's guidelines draw theirs as, and the
 * shape every provider takes so the set reads as one row of choices.
 */
export type SignInOptionTone = "ink" | "plate";

/** A provider's mark on its button: a notch up from an inline glyph. */
export const MARK_SIZE = sizing.actionSheet.icon;
/**
 * Apple's glyph sits inside a good deal of clear space in its own artwork, so
 * at the shared size it read smaller than the G beside it. Drawn larger, the
 * two look the same size.
 */
const APPLE_MARK_SIZE = spacing[7];

export interface SignInOptionButtonProps {
  label: string;
  icon: ReactNode;
  onPress: () => void;
  tone?: SignInOptionTone;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

/** One way to sign in, drawn the way the platforms' own buttons are drawn. */
export function SignInOptionButton({
  label,
  icon,
  onPress,
  tone = "plate",
  disabled = false,
  loading = false,
  accessibilityLabel,
  testID,
}: SignInOptionButtonProps) {
  const theme = useTheme();
  const inactive = disabled || loading;
  const ink = tone === "ink";
  const contentColor = ink ? "primaryForeground" : "foreground";

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ busy: loading, disabled: inactive }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: ink ? theme.colors.primary : theme.colors.card,
          borderColor: ink ? theme.colors.primary : theme.colors.border,
          borderRadius: theme.radii.md,
          opacity: inactive ? opacity.disabled : pressed ? opacity.pressedContent : opacity.opaque,
        },
      ]}
      {...(testID === undefined ? {} : { testID })}
    >
      <View style={styles.mark}>
        {loading ? <Spinner color={contentColor} size={sizing.control.spinner} /> : icon}
      </View>
      <Text color={contentColor} variant="uiBase" weight="medium">
        {label}
      </Text>
    </Pressable>
  );
}

export interface OAuthButtonsProps {
  loading?: boolean;
  providers: readonly AuthProviderOut[];
  /**
   * Carried through the provider round trip so a closed deployment can admit
   * the account at the callback. There is no form between this button and the
   * account being created, so this is the only chance to supply one.
   */
  invite?: string | null;
  /** Held back — while the server they would sign in to is still being chosen. */
  disabled?: boolean;
  /** A ruled "or" above the set, for a screen that has already offered a form. */
  divider?: boolean;
}

/**
 * The third-party ways in, one button each, drawn as the platforms draw them:
 * Apple's filled slab with its mark, Google's bordered plate with the G.
 */
export function OAuthButtons({
  invite = null,
  loading = false,
  providers,
  disabled = false,
  divider = false,
}: OAuthButtonsProps) {
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
      {divider ? (
        <View accessibilityElementsHidden style={styles.dividerRow}>
          <View style={[styles.line, { backgroundColor: theme.colors.border }]} />
          <Text color="mutedForeground" variant="sigilLabel">
            Or
          </Text>
          <View style={[styles.line, { backgroundColor: theme.colors.border }]} />
        </View>
      ) : null}
      <View style={styles.buttons}>
        {listed.map((provider) => (
          <SignInOptionButton
            accessibilityLabel={`Continue with ${provider.name}`}
            disabled={disabled || pending}
            icon={<ProviderMark provider={provider.id} size={MARK_SIZE} />}
            key={provider.id}
            label={`Continue with ${provider.name}`}
            loading={pending && signIn.variables?.provider === provider.id}
            onPress={press(provider.id)}
            testID={`sign-in-${provider.id}`}
          />
        ))}
        {showApple ? (
          <SignInOptionButton
            accessibilityLabel="Continue with Apple"
            disabled={disabled || pending}
            icon={<ProviderMark provider="apple" size={APPLE_MARK_SIZE} />}
            key="apple"
            label="Continue with Apple"
            loading={pending && signIn.variables?.provider === "apple"}
            onPress={press("apple")}
            testID="sign-in-apple"
          />
        ) : null}
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
  button: {
    alignItems: "center",
    borderWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: spacing[3],
    justifyContent: "center",
    minHeight: sizing.control.button.lg,
    paddingHorizontal: spacing[4],
    width: "100%",
  },
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
  mark: {
    alignItems: "center",
    height: spacing[6],
    justifyContent: "center",
    width: spacing[6],
  },
  reason: {
    textAlign: "center",
  },
});
