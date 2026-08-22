import { Linking, ScrollView, StyleSheet, View } from "react-native";
import { parseMarkdown, safeMarkdownUrl } from "@/components/files/markdown-policy";
import { Text } from "@/components/ui/text";
import { borderWidth, spacing, useTheme } from "@/theme";

export function MarkdownPreview({ source }: { source: string }) {
  const theme = useTheme();
  const blocks = parseMarkdown(source);
  return (
    <ScrollView contentContainerStyle={styles.content}>
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        switch (block.kind) {
          case "heading":
            return (
              <Text
                accessibilityRole="header"
                key={key}
                style={
                  block.level === 1
                    ? {
                        fontSize: theme.type.fontSize.displaySm,
                        lineHeight: theme.type.lineHeight.xl,
                      }
                    : styles.heading
                }
                variant="title"
              >
                {block.text}
              </Text>
            );
          case "code":
            return (
              <Text
                key={key}
                selectable
                style={[
                  styles.code,
                  { backgroundColor: theme.colors.muted, borderRadius: theme.radii.md },
                ]}
                variant="mono"
              >
                {block.text}
              </Text>
            );
          case "quote":
            return (
              <View
                key={key}
                style={[
                  styles.quote,
                  { backgroundColor: theme.colors.muted, borderRadius: theme.radii.md },
                ]}
              >
                <Text>{block.text}</Text>
              </View>
            );
          case "list":
            return (
              <View key={key} style={styles.list}>
                {block.items.map((item, itemIndex) => (
                  // Duplicate list items are valid Markdown, so source position is the only stable identity.
                  // biome-ignore lint/suspicious/noArrayIndexKey: immutable parsed document rows never reorder.
                  <View key={`${key}-${itemIndex}`} style={styles.listRow}>
                    <Text color="mutedForeground">{block.ordered ? `${itemIndex + 1}.` : "•"}</Text>
                    <Text style={styles.listText}>{item}</Text>
                  </View>
                ))}
              </View>
            );
          case "table":
            return (
              <ScrollView horizontal key={key}>
                <View style={[styles.table, { borderColor: theme.colors.border }]}>
                  {block.rows.map((row, rowIndex) => (
                    <View
                      // Duplicate table rows are valid and parsed output never reorders.
                      // biome-ignore lint/suspicious/noArrayIndexKey: source position is the row identity.
                      key={`${key}-${rowIndex}`}
                      style={[
                        styles.tableRow,
                        rowIndex === 0 ? { backgroundColor: theme.colors.muted } : undefined,
                      ]}
                    >
                      {row.map((cell, cellIndex) => (
                        // Duplicate cells are valid and have no identity beyond their source position.
                        // biome-ignore lint/suspicious/noArrayIndexKey: source position is the cell identity.
                        <Text key={`${key}-${rowIndex}-${cellIndex}`} style={styles.cell}>
                          {cell}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            );
          case "paragraph":
            return <MarkdownParagraph key={key} text={block.text} />;
        }
        return null;
      })}
    </ScrollView>
  );
}

function MarkdownParagraph({ text }: { text: string }) {
  const match = /^(.*) \((https?:\/\/[^)]+|mailto:[^)]+)\)$/iu.exec(text);
  if (!match || !safeMarkdownUrl(match[2] ?? "")) return <Text selectable>{text}</Text>;
  return (
    <Text selectable>
      {match[1]}{" "}
      <Text
        accessibilityLabel={`Open ${match[2]}`}
        accessibilityRole="link"
        color="info"
        onPress={() => void Linking.openURL(match[2] ?? "")}
      >
        {match[2]}
      </Text>
    </Text>
  );
}

const styles = StyleSheet.create({
  cell: { minWidth: spacing[24], padding: spacing[2] },
  code: { padding: spacing[3] },
  content: { gap: spacing[4], padding: spacing[4], paddingBottom: spacing[12] },
  heading: { marginTop: spacing[2] },
  list: { gap: spacing[1] },
  listRow: { flexDirection: "row", gap: spacing[2] },
  listText: { flex: 1 },
  quote: { padding: spacing[3] },
  table: { borderWidth: borderWidth.hairline },
  tableRow: { flexDirection: "row" },
});
