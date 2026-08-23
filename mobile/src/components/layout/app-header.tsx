import { createContext, type ReactNode, useContext } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { BrandMark } from "@/components/brand/brand-mark";
import { isPrimaryHeaderDestinationAction } from "@/components/nav/primary-destinations";
import type { IconName } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { borderWidth, spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export interface AppHeaderAction {
  icon: IconName;
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
}

export interface AppHeaderProps {
  title: string;
  /**
   * A destination root, which wears the spawnd mark instead of its own name. The
   * title still names the screen for assistive tech; the bar just stops saying
   * out loud what the tab bar underneath already says.
   */
  branded?: boolean;
  /** Optional second line under the title. */
  subtitle?: string;
  /** A root-screen control rendered instead of the back chevron. */
  leading?: ReactNode;
  /** Shows a standard back chevron. Omit on a root screen. */
  onBack?: () => void;
  /** Trailing icon actions, laid out right-aligned. Max 3. */
  actions?: readonly AppHeaderAction[];
  /** A trailing control that is not an icon button (e.g. a Switch). */
  accessory?: ReactNode;
  /** Hairline under the bar. Default true. */
  divider?: boolean;
  testID?: string;
}

const MAX_ACTIONS = 3;
interface AppHeaderNavigationDefaults {
  backOverride?: () => void;
  leading: ReactNode;
}

const AppHeaderNavigationContext = createContext<AppHeaderNavigationDefaults>({ leading: null });

export function AppHeaderLeadingProvider({
  backOverride,
  children,
  leading,
}: {
  backOverride?: () => void;
  children: ReactNode;
  leading: ReactNode;
}): React.JSX.Element {
  return (
    <AppHeaderNavigationContext.Provider
      value={{ ...(backOverride === undefined ? {} : { backOverride }), leading }}
    >
      {children}
    </AppHeaderNavigationContext.Provider>
  );
}

export function AppHeader({
  title,
  branded = false,
  subtitle,
  leading,
  onBack,
  actions,
  accessory,
  divider = true,
  testID,
}: AppHeaderProps): React.JSX.Element {
  const navigationDefaults = useContext(AppHeaderNavigationContext);
  const insets = useContext(SafeAreaInsetsContext) ?? {
    bottom: spacing[0],
    left: spacing[0],
    right: spacing[0],
    top: spacing[0],
  };
  const theme = useTheme();
  // Older route screens still declare Hosts/Settings actions. The global header is the
  // enforcement boundary: primary destinations belong exclusively to persistent tabs,
  // while contextual actions such as create, connect, Legion, and Admin remain intact.
  const visibleActions = actions
    ?.filter((action) => !isPrimaryHeaderDestinationAction(action))
    .slice(0, MAX_ACTIONS);
  const resolvedBack = navigationDefaults.backOverride ?? onBack;
  // A screen has a back control or a root control, never both — and which it is
  // is a property of the screen, not of the current path. Deciding by pathname
  // blanked the avatar the instant a push began, so it vanished for the length of
  // the animation and reappeared on the way back.
  const resolvedLeading =
    leading ?? (resolvedBack === undefined ? navigationDefaults.leading : null);

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: theme.colors.background,
          borderBottomColor: theme.colors.border,
          borderBottomWidth: divider ? borderWidth.hairline : borderWidth.none,
          paddingTop: insets.top,
        },
      ]}
      {...(testID === undefined ? {} : { testID })}
    >
      <View
        style={[
          styles.bar,
          {
            paddingLeft: insets.left + sizing.appHeader.horizontalPadding,
            paddingRight: insets.right + sizing.appHeader.horizontalPadding,
          },
        ]}
      >
        <View style={styles.leadingSlot} testID="app-header-leading-slot">
          {resolvedLeading ??
            (resolvedBack === undefined ? null : (
              <IconButton
                accessibilityLabel="Go back"
                icon="ChevronLeft"
                onPress={resolvedBack}
                size="lg"
                style={styles.action}
                variant="ghost"
              />
            ))}
        </View>

        <View pointerEvents="none" style={styles.titleFrame} testID="app-header-title-frame">
          {branded ? (
            <BrandMark accessibilityLabel={title} size={sizing.appHeader.brandMark} />
          ) : (
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              style={styles.title}
              weight="semibold"
            >
              {title}
            </Text>
          )}
          {subtitle === undefined ? null : (
            <Text color="mutedForeground" numberOfLines={1} style={styles.subtitle}>
              {subtitle}
            </Text>
          )}
        </View>

        <View style={styles.trailingSlot} testID="app-header-trailing-slot">
          {accessory === undefined &&
          (visibleActions === undefined || visibleActions.length === 0) ? null : (
            <View style={styles.actions}>
              {accessory}
              {visibleActions?.map((action) => (
                <IconButton
                  accessibilityLabel={action.accessibilityLabel}
                  icon={action.icon}
                  key={action.testID ?? action.accessibilityLabel}
                  onPress={action.onPress}
                  size="lg"
                  style={styles.action}
                  variant="ghost"
                  {...(action.busy === undefined ? {} : { loading: action.busy })}
                  {...(action.disabled === undefined ? {} : { disabled: action.disabled })}
                  {...(action.testID === undefined ? {} : { testID: action.testID })}
                />
              ))}
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    height: sizing.appHeader.actionTarget,
    minHeight: sizing.appHeader.actionTarget,
    minWidth: sizing.appHeader.actionTarget,
    width: sizing.appHeader.actionTarget,
  },
  actions: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.appHeader.actionGap,
  },
  bar: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: sizing.appHeader.minHeight,
  },
  leadingSlot: {
    alignItems: "flex-start",
    justifyContent: "center",
    minHeight: sizing.appHeader.minHeight,
    width: sizing.appHeader.sideSlot,
  },
  root: {
    width: "100%",
  },
  subtitle: {
    fontSize: sizing.type.caption.fontSize,
    lineHeight: sizing.type.caption.lineHeight,
    textAlign: "center",
  },
  title: {
    fontSize: sizing.type.navigationTitle.fontSize,
    lineHeight: sizing.type.navigationTitle.lineHeight,
    textAlign: "center",
  },
  titleFrame: {
    alignItems: "center",
    flex: 1,
    gap: sizing.appHeader.subtitleGap,
    justifyContent: "center",
    paddingHorizontal: sizing.appHeader.titleGap,
  },
  trailingSlot: {
    alignItems: "flex-end",
    justifyContent: "center",
    minHeight: sizing.appHeader.minHeight,
    width: sizing.appHeader.sideSlot,
  },
});
