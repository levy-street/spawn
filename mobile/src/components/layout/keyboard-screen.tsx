import { type ReactNode, useState } from "react";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import {
  KeyboardAwareScrollView,
  useGenericKeyboardHandler,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useBottomChromeOwnsInset } from "@/components/layout/bottom-chrome";
import { FooterActions } from "@/components/ui/footer-actions";
import { spacing } from "@/theme";
import { bottomNavHeight } from "@/theme/sizing";

interface KeyboardScreenProps {
  children: ReactNode;
  contentInsets: {
    paddingBottom: number;
    paddingLeft: number;
    paddingRight: number;
    paddingTop: number;
  };
  footer: ReactNode | undefined;
  header: ReactNode | undefined;
  scroll: boolean;
}

interface KeyboardFooterProps {
  children: ReactNode;
  onLayout: (event: LayoutChangeEvent) => void;
}

function KeyboardFooter({ children, onLayout }: KeyboardFooterProps): React.JSX.Element {
  const { height, progress } = useReanimatedKeyboardAnimation();
  const targetProgress = useSharedValue(progress.value);
  const insets = useSafeAreaInsets();
  // The nav bar is portalled to window level and draws over this footer — over a
  // form dialog's actions as readily as a route's. Nothing else holds its
  // footprint open down here, so the footer reserves it while the keyboard is down.
  const reservedBottomChrome = useBottomChromeOwnsInset() ? bottomNavHeight(insets.bottom) : 0;

  useGenericKeyboardHandler(
    {
      onStart: (event) => {
        "worklet";
        targetProgress.value = event.progress;
      },
      onEnd: (event) => {
        "worklet";
        targetProgress.value = event.progress;
      },
    },
    [targetProgress],
  );

  return (
    <View onLayout={onLayout} style={styles.footer} testID="screen-footer">
      <FooterActions
        keyboardAnimation={{ height, progress, targetProgress }}
        reservedBottomChrome={reservedBottomChrome}
      >
        {children}
      </FooterActions>
    </View>
  );
}

export function KeyboardScreen({
  children,
  contentInsets,
  footer,
  header,
  scroll,
}: KeyboardScreenProps): React.JSX.Element {
  const [footerHeight, setFooterHeight] = useState(0);
  const onFooterLayout = (event: LayoutChangeEvent) => {
    setFooterHeight(event.nativeEvent.layout.height);
  };

  return (
    <View style={styles.root} testID="screen">
      {header}
      {scroll ? (
        <KeyboardAwareScrollView
          bottomOffset={spacing[3]}
          contentContainerStyle={[styles.scrollContent, contentInsets]}
          contentInsetAdjustmentBehavior="never"
          extraKeyboardSpace={footer === undefined ? spacing[0] : footerHeight}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          testID="screen-content"
        >
          {children}
        </KeyboardAwareScrollView>
      ) : (
        <View style={[styles.content, contentInsets]} testID="screen-content">
          {children}
        </View>
      )}

      {footer === undefined ? null : (
        <KeyboardFooter onLayout={onFooterLayout}>{footer}</KeyboardFooter>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
  },
  footer: {
    width: "100%",
  },
  root: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
});
