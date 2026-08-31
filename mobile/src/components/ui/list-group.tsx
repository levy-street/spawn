import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "@/components/ui/text";
import { borderWidth, spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

/**
 * The app's list surface: a heading with a rule under it, entries divided by
 * hairlines that run to both screen edges, and a closing rule under the last
 * of them so the group reads as a block rather than trailing off.
 *
 * Every page draws its lists through this rather than stacking cards, so a row
 * of settings, a machine's sessions and an admin record all read as the same
 * kind of object. A group cancels the page gutter and its entries re-apply it
 * as padding, which is what keeps their labels aligned with the copy above and
 * below the list.
 */

export interface ListGroupHeadingProps {
  title: string;
  description?: string;
  /** A control belonging to the heading — a count, a refresh button. */
  trailing?: ReactNode;
  testID?: string;
}

export function ListGroupHeading({
  title,
  description,
  trailing,
  testID,
}: ListGroupHeadingProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.heading} testID={testID}>
      <View style={styles.headingRow}>
        <View style={styles.headingCopy}>
          <Text
            accessibilityRole="header"
            color="mutedForeground"
            variant="caption"
            weight="semibold"
          >
            {title}
          </Text>
          {description === undefined ? null : (
            <Text color="mutedForeground" variant="caption">
              {description}
            </Text>
          )}
        </View>
        {trailing === undefined ? null : <View style={styles.headingTrailing}>{trailing}</View>}
      </View>
      <View style={[styles.rule, { backgroundColor: theme.colors.border }]} />
    </View>
  );
}

export interface ListBlockProps {
  children: ReactNode;
  /** Set false when the content lays out its own padding. Default true. */
  padded?: boolean;
  /**
   * Reaches past the page gutter to both screen edges. Default true; set false
   * inside a `ListGroup`, which has already done it for the whole group.
   */
  bleed?: boolean;
  testID?: string;
}

/**
 * An entry that is more than a row — a form, a record with its own controls, a
 * few lines of copy — drawn on the page rather than on a card of its own.
 */
export function ListBlock({
  children,
  padded = true,
  bleed = true,
  testID,
}: ListBlockProps): React.JSX.Element {
  return (
    <View style={[padded ? styles.block : null, bleed ? styles.bleed : null]} testID={testID}>
      {children}
    </View>
  );
}

export interface ListGroupProps {
  children: ReactNode;
  /**
   * Draws the rule a heading would have opened the group with. For a group
   * that stands on its own under plain copy: without it the first entry has a
   * rule below and none above, and reads as hanging off the text over it.
   */
  openingRule?: boolean;
  testID?: string;
}

export function ListGroup({
  children,
  openingRule = false,
  testID,
}: ListGroupProps): React.JSX.Element {
  const theme = useTheme();
  const items = Children.toArray(children).filter((child): child is ReactElement =>
    isValidElement(child),
  );

  return (
    <View style={styles.group} testID={testID}>
      {openingRule && items.length > 0 ? (
        <View
          style={[styles.separator, { backgroundColor: theme.colors.border }]}
          testID="list-group-start"
        />
      ) : null}
      {items.map((item, index) => (
        <View key={String(item.key)}>
          {index > 0 ? (
            <View
              style={[styles.separator, { backgroundColor: theme.colors.border }]}
              testID="list-group-separator"
            />
          ) : null}
          {item}
        </View>
      ))}
      {items.length > 0 ? (
        // The rule that closes the group, answering the one under the heading.
        <View
          style={[styles.separator, { backgroundColor: theme.colors.border }]}
          testID="list-group-end"
        />
      ) : null}
    </View>
  );
}

/** How far a group reaches past the page gutter to touch both screen edges. */
const GUTTER = sizing.screen.gutter;

const styles = StyleSheet.create({
  bleed: {
    marginHorizontal: -GUTTER,
  },
  block: {
    gap: spacing[3],
    paddingHorizontal: GUTTER,
    paddingVertical: spacing[3],
  },
  group: {
    marginHorizontal: -GUTTER,
  },
  heading: {
    // The rule belongs to the heading, so it sits closer to the title than to
    // the list it opens; the list starts immediately under it.
    gap: spacing[2.5],
  },
  headingCopy: {
    flex: 1,
    gap: spacing[1],
    minWidth: 0,
  },
  headingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
  headingTrailing: {
    alignItems: "center",
    justifyContent: "center",
  },
  rule: {
    height: borderWidth.hairline,
    marginHorizontal: -GUTTER,
  },
  separator: {
    height: borderWidth.hairline,
  },
});
