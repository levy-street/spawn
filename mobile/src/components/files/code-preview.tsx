import { FlashList } from "@shopify/flash-list";
import { StyleSheet, View } from "react-native";
import { type TokenKind, tokenizeCode } from "@/components/files/code-tokenize";
import type { CodeLanguage } from "@/components/files/types";
import { Text, type TextColor } from "@/components/ui/text";
import { borderWidth, spacing, useTheme } from "@/theme";

const TOKEN_COLORS: Record<TokenKind, TextColor> = {
  plain: "foreground",
  comment: "codeComment",
  string: "codeString",
  keyword: "codeKeyword",
  number: "codeNumber",
  tag: "codeKeyword",
  attr: "codeString",
  punct: "codePunct",
};

export function CodePreview({ source, language }: { source: string; language: CodeLanguage }) {
  const theme = useTheme();
  const lines = tokenizeCode(source, language);
  return (
    <FlashList
      data={lines}
      keyExtractor={(_, index) => String(index)}
      renderItem={({ item, index }) => (
        <View style={styles.line}>
          <Text
            accessibilityElementsHidden
            color="mutedForeground"
            style={[styles.lineNumber, { borderRightColor: theme.colors.border }]}
            variant="mono"
          >
            {index + 1}
          </Text>
          <Text selectable style={styles.source} variant="mono">
            {item.length === 0
              ? " "
              : item.map((token, tokenIndex) => (
                  <Text
                    color={TOKEN_COLORS[token.kind]}
                    // Token spans are immutable and have no identity beyond their source position.
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable source position is the token identity.
                    key={`${index}-${tokenIndex}`}
                    variant="mono"
                  >
                    {token.text}
                  </Text>
                ))}
          </Text>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  line: {
    alignItems: "flex-start",
    flexDirection: "row",
    minHeight: spacing[5],
  },
  lineNumber: {
    borderRightWidth: borderWidth.hairline,
    minWidth: spacing[12],
    paddingHorizontal: spacing[2],
    textAlign: "right",
  },
  source: {
    flex: 1,
    paddingHorizontal: spacing[3],
  },
});
