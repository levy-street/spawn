import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import {
  isSettingsRow,
  SettingsGroupedProvider,
  useSettingsGrouped,
} from "@/components/settings/settings-grouped";
import { ListGroup, ListGroupHeading } from "@/components/ui/list-group";
import { spacing } from "@/theme";

export interface SettingsSectionProps {
  title?: string;
  description?: string;
  children: ReactNode;
  testID?: string;
}

/**
 * One group of settings: a heading, a rule, and its entries.
 *
 * Rows inside a section are drawn as a plain list — hairlines between them, no
 * card around each one — through the same `ListGroup` every other page uses.
 * Anything that is not a row (a button, a field, an empty state) stays in the
 * padded column where it belongs, so a section can mix the two without either
 * looking wrong.
 */
export function SettingsSection({
  title,
  description,
  children,
  testID,
}: SettingsSectionProps): React.JSX.Element {
  // `Children.toArray` keys every child, so a block can be keyed by its first
  // one rather than by where it happens to sit.
  const items = Children.toArray(children).filter((child): child is ReactElement =>
    isValidElement(child),
  );

  // Consecutive rows become one list; everything else keeps its own place in
  // the column, in the order it was written.
  const blocks: Array<{ rows: boolean; key: string; items: ReactElement[] }> = [];
  for (const item of items) {
    const rows = isSettingsRow(item);
    const current = blocks.at(-1);
    if (current && current.rows === rows) current.items.push(item);
    else blocks.push({ rows, key: String(item.key), items: [item] });
  }

  return (
    <View style={styles.section} testID={testID}>
      {title === undefined ? null : (
        <ListGroupHeading title={title} {...(description === undefined ? {} : { description })} />
      )}
      <View style={styles.content}>
        {blocks.map((block) =>
          block.rows ? (
            <SettingsGroupedProvider key={block.key} value={true}>
              <ListGroup>{block.items}</ListGroup>
            </SettingsGroupedProvider>
          ) : (
            <View key={block.key} style={styles.loose}>
              {block.items}
            </View>
          ),
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing[0],
  },
  // A list starts straight under the heading's rule. Anything that is not a
  // list carries its own air instead, above and below.
  loose: {
    gap: spacing[3],
    paddingVertical: spacing[3],
  },
  section: {
    gap: spacing[0],
  },
});

/** Re-exported so rows can ask whether a section is drawing them. */
export { useSettingsGrouped };
