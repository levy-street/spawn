import type { ReactNode } from "react";
import { markSettingsRow, useSettingsGrouped } from "@/components/settings/settings-grouped";
import { ListBlock } from "@/components/ui/list-group";

export interface SettingsBlockProps {
  children: ReactNode;
  /** Set false when the content lays out its own padding. Default true. */
  padded?: boolean;
  testID?: string;
}

/**
 * A settings entry that is more than a row — a form, a record with its own
 * controls, a few lines of copy.
 *
 * Cards stacked down a settings page turn every entry into an object you have
 * to parse the edges of. A block keeps the content and drops the frame: inside
 * a section it becomes one hairline-separated entry, and on its own it still
 * runs to both screen edges so it lines up with the lists around it.
 */
export function SettingsBlock({
  children,
  padded = true,
  testID,
}: SettingsBlockProps): React.JSX.Element {
  const grouped = useSettingsGrouped();
  return (
    <ListBlock bleed={!grouped} padded={padded} {...(testID === undefined ? {} : { testID })}>
      {children}
    </ListBlock>
  );
}

markSettingsRow(SettingsBlock);
