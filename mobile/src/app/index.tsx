import { StyleSheet, Text, View } from "react-native";

import { ThemeProvider, useTheme } from "@/theme";

function SpawnPlaceholder() {
  const theme = useTheme();

  return (
    <View style={[styles.screen, { backgroundColor: theme.colors.background }]}>
      <Text
        accessibilityRole="header"
        accessibilityLabel="spawn"
        style={[
          styles.wordmark,
          {
            color: theme.colors.foreground,
            fontFamily: theme.type.fontFamily.sigil,
            fontSize: theme.type.fontSize.displaySm,
            lineHeight: theme.type.fontSize.displaySm * theme.type.displayLineHeightRatio.r125,
            letterSpacing: theme.type.fontSize.displaySm * theme.type.letterSpacing.sigil18Em,
          },
        ]}
      >
        spawn
      </Text>
    </View>
  );
}

export default function IndexScreen() {
  return (
    <ThemeProvider>
      <SpawnPlaceholder />
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  screen: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  wordmark: {
    textTransform: "uppercase",
  },
});
