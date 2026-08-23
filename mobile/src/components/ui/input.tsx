import { forwardRef, type ReactNode, type RefObject, useState } from "react";
import {
  Pressable,
  type StyleProp,
  StyleSheet,
  TextInput,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Icon } from "@/components/ui/icon";
import { useTheme } from "@/theme";
import { opacity } from "@/theme/effects";
import { borderWidth, chrome, radii, spacing } from "@/theme/spacing";
import { typeStyles } from "@/theme/typography";

export type InputPurpose =
  | "email"
  | "password"
  | "newPassword"
  | "oneTimeCode"
  | "url"
  | "path"
  | "name"
  | "search"
  | "plain";

export interface InputPurposeConfig {
  autoCapitalize: NonNullable<TextInputProps["autoCapitalize"]>;
  autoCorrect: boolean;
  spellCheck: boolean;
  keyboardType: NonNullable<TextInputProps["keyboardType"]>;
  textContentType: NonNullable<TextInputProps["textContentType"]>;
  autoComplete: NonNullable<TextInputProps["autoComplete"]>;
  smartInsertDelete: boolean;
  secureTextEntry: boolean;
}

const INPUT_PURPOSE_CONFIG = {
  email: {
    autoCapitalize: "none",
    autoCorrect: false,
    spellCheck: false,
    keyboardType: "email-address",
    textContentType: "emailAddress",
    autoComplete: "email",
    smartInsertDelete: false,
    secureTextEntry: false,
  },
  password: {
    autoCapitalize: "none",
    autoCorrect: false,
    spellCheck: false,
    keyboardType: "default",
    textContentType: "password",
    autoComplete: "current-password",
    smartInsertDelete: false,
    secureTextEntry: true,
  },
  newPassword: {
    autoCapitalize: "none",
    autoCorrect: false,
    spellCheck: false,
    keyboardType: "default",
    textContentType: "newPassword",
    autoComplete: "new-password",
    smartInsertDelete: false,
    secureTextEntry: true,
  },
  oneTimeCode: {
    autoCapitalize: "characters",
    autoCorrect: false,
    spellCheck: false,
    keyboardType: "default",
    textContentType: "oneTimeCode",
    autoComplete: "one-time-code",
    smartInsertDelete: false,
    secureTextEntry: false,
  },
  url: {
    autoCapitalize: "none",
    autoCorrect: false,
    spellCheck: false,
    keyboardType: "url",
    textContentType: "URL",
    autoComplete: "url",
    smartInsertDelete: false,
    secureTextEntry: false,
  },
  path: {
    autoCapitalize: "none",
    autoCorrect: false,
    spellCheck: false,
    keyboardType: "default",
    textContentType: "none",
    autoComplete: "off",
    smartInsertDelete: false,
    secureTextEntry: false,
  },
  name: {
    autoCapitalize: "words",
    autoCorrect: false,
    spellCheck: false,
    keyboardType: "default",
    textContentType: "name",
    autoComplete: "name",
    smartInsertDelete: true,
    secureTextEntry: false,
  },
  search: {
    autoCapitalize: "none",
    autoCorrect: false,
    spellCheck: false,
    keyboardType: "web-search",
    textContentType: "none",
    autoComplete: "off",
    smartInsertDelete: false,
    secureTextEntry: false,
  },
  plain: {
    autoCapitalize: "none",
    autoCorrect: false,
    spellCheck: false,
    keyboardType: "default",
    textContentType: "none",
    autoComplete: "off",
    smartInsertDelete: false,
    secureTextEntry: false,
  },
} as const satisfies Record<InputPurpose, InputPurposeConfig>;

export function getInputPurposeConfig(purpose: InputPurpose): InputPurposeConfig {
  return INPUT_PURPOSE_CONFIG[purpose];
}

export interface InputProps extends Omit<TextInputProps, "style"> {
  purpose?: InputPurpose;
  error?: boolean;
  nextRef?: RefObject<TextInput | null>;
  leading?: ReactNode;
  trailing?: ReactNode;
  showFocusHalo?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<TextStyle>;
}

export const Input = forwardRef<TextInput, InputProps>(function Input(
  {
    purpose = "plain",
    error = false,
    nextRef,
    leading,
    trailing,
    showFocusHalo = true,
    containerStyle,
    style,
    editable = true,
    autoCapitalize,
    autoCorrect,
    spellCheck,
    keyboardType,
    textContentType,
    autoComplete,
    smartInsertDelete,
    secureTextEntry,
    returnKeyType,
    onFocus,
    onBlur,
    onSubmitEditing,
    accessibilityState,
    testID,
    ...props
  },
  ref,
) {
  const theme = useTheme();
  const config = getInputPurposeConfig(purpose);
  const focusProgress = useSharedValue(0);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const isPasswordPurpose = purpose === "password" || purpose === "newPassword";
  const purposeSecureEntry = secureTextEntry ?? config.secureTextEntry;

  const animatedHaloStyle = useAnimatedStyle(
    () => ({
      borderColor: error ? theme.colors.destructive : theme.colors.ring,
      opacity: showFocusHalo ? focusProgress.value : opacity.hidden,
    }),
    [error, showFocusHalo, theme.colors.destructive, theme.colors.ring],
  );

  const animateFocus = (focused: boolean) => {
    focusProgress.value = withTiming(focused ? 1 : 0, {
      duration: theme.motion.duration.base,
      easing: theme.motion.easing.inOut,
      reduceMotion: ReduceMotion.System,
    });
  };

  const handleSubmit: NonNullable<TextInputProps["onSubmitEditing"]> = (event) => {
    onSubmitEditing?.(event);
    nextRef?.current?.focus();
  };

  const hasPasswordToggle = isPasswordPurpose && purposeSecureEntry;
  const hasTrailingContent = trailing !== undefined || hasPasswordToggle;

  return (
    <Animated.View
      style={[
        styles.container,
        { borderColor: error ? theme.colors.destructive : theme.colors.input },
        !editable && styles.disabled,
        containerStyle,
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[styles.focusHalo, animatedHaloStyle]}
        testID={testID === undefined ? undefined : `${testID}-focus-halo`}
      />
      {leading !== undefined ? (
        <Animated.View style={styles.leading}>{leading}</Animated.View>
      ) : null}
      <TextInput
        {...props}
        ref={ref}
        testID={testID}
        editable={editable}
        autoCapitalize={autoCapitalize ?? config.autoCapitalize}
        autoCorrect={autoCorrect ?? config.autoCorrect}
        spellCheck={spellCheck ?? config.spellCheck}
        keyboardType={keyboardType ?? config.keyboardType}
        textContentType={textContentType ?? config.textContentType}
        autoComplete={autoComplete ?? config.autoComplete}
        smartInsertDelete={smartInsertDelete ?? config.smartInsertDelete}
        secureTextEntry={hasPasswordToggle ? !passwordVisible : purposeSecureEntry}
        returnKeyType={returnKeyType ?? (nextRef === undefined ? "done" : "next")}
        onFocus={(event) => {
          animateFocus(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          animateFocus(false);
          onBlur?.(event);
        }}
        onSubmitEditing={handleSubmit}
        accessibilityRole={purpose === "search" ? "search" : props.accessibilityRole}
        accessibilityState={{ ...accessibilityState, disabled: !editable }}
        aria-invalid={error || undefined}
        placeholderTextColor={props.placeholderTextColor ?? theme.colors.mutedForeground}
        selectionColor={props.selectionColor ?? theme.colors.brandAccent}
        style={[
          styles.input,
          leading !== undefined && styles.inputWithLeading,
          hasTrailingContent && styles.inputWithTrailing,
          { color: theme.colors.foreground },
          style,
        ]}
      />
      {trailing !== undefined ? (
        <Animated.View style={styles.trailing}>{trailing}</Animated.View>
      ) : null}
      {hasPasswordToggle ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={passwordVisible ? "Hide password" : "Show password"}
          disabled={!editable}
          onPress={() => setPasswordVisible((visible) => !visible)}
          style={styles.trailingAction}
        >
          <Icon
            name={passwordVisible ? "EyeOff" : "Eye"}
            size={spacing[4]}
            color="mutedForeground"
          />
        </Pressable>
      ) : null}
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: borderWidth.hairline,
    flexDirection: "row",
    height: chrome.touchTarget,
    position: "relative",
    width: "100%",
  },
  focusHalo: {
    borderRadius: radii.md,
    borderWidth: borderWidth.hairline,
    bottom: -borderWidth.hairline,
    left: -borderWidth.hairline,
    position: "absolute",
    right: -borderWidth.hairline,
    top: -borderWidth.hairline,
  },
  disabled: {
    opacity: opacity.disabled,
  },
  input: {
    // iOS lays a single-line TextInput's text out from the top of its content
    // box when a lineHeight is set, which pushed the value and placeholder below
    // the field's optical centre. Height plus flex centring does the job without
    // it, so only the face and weight are taken from the shared type style.
    fontSize: typeStyles.uiSm.fontSize,
    fontWeight: typeStyles.uiSm.fontWeight,
    flex: 1,
    height: "100%",
    paddingHorizontal: spacing[3],
    paddingVertical: 0,
  },
  inputWithLeading: {
    // Clear of the leading glyph rather than crowding it.
    paddingLeft: spacing[2],
  },
  inputWithTrailing: {
    paddingRight: spacing[1],
  },
  leading: {
    alignItems: "center",
    justifyContent: "center",
    marginLeft: spacing[3],
  },
  trailing: {
    alignItems: "center",
    justifyContent: "center",
  },
  trailingAction: {
    alignItems: "center",
    height: chrome.touchTarget,
    justifyContent: "center",
    width: chrome.touchTarget,
  },
});
