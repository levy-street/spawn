import { type ReactNode, useState } from "react";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import { KeyboardAwareScrollView, KeyboardStickyView } from "react-native-keyboard-controller";

import { FooterActions } from "@/components/ui/footer-actions";
import { spacing } from "@/theme";

interface KeyboardScreenProps {
  children: ReactNode;
  contentInsets: {
    paddingBottom: number;
    paddingLeft: number;
    paddingRight: number;
    paddingTop: number;
  };
  footer: ReactNode | undefined;
  scroll: boolean;
}

export function KeyboardScreen({
  children,
  contentInsets,
  footer,
  scroll,
}: KeyboardScreenProps): React.JSX.Element {
  const [footerHeight, setFooterHeight] = useState(0);
  const onFooterLayout = (event: LayoutChangeEvent) => {
    setFooterHeight(event.nativeEvent.layout.height);
  };

  return (
    <View style={styles.root} testID="screen">
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
        <KeyboardStickyView offset={{ closed: spacing[0], opened: spacing[0] }}>
          <View onLayout={onFooterLayout} style={styles.footer} testID="screen-footer">
            <FooterActions>{footer}</FooterActions>
          </View>
        </KeyboardStickyView>
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
