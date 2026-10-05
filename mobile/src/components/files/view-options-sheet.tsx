import { StyleSheet, View } from "react-native";
import { FOLDERS_ON_TOP_LABEL, SHOW_HIDDEN_LABEL } from "@/components/files/copy";
import {
  defaultSortDirection,
  FILE_SORT_DIRECTION_LABELS,
  FILE_SORT_KEYS,
  FILE_SORT_LABELS,
  type FileSort,
  type FileSortDirection,
  type FileSortKey,
} from "@/components/files/sort";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet, SheetHeader } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useTheme } from "@/theme";

export interface ViewOptionsSheetProps {
  visible: boolean;
  sort: FileSort;
  foldersFirst: boolean;
  showHidden: boolean;
  onSortChange: (sort: FileSort) => void;
  onFoldersFirstChange: (foldersFirst: boolean) => void;
  onShowHiddenChange: (showHidden: boolean) => void;
  onDismiss: () => void;
}

const SORT_FIELD_OPTIONS = FILE_SORT_KEYS.map((key) => ({
  value: key,
  label: key === "modified" ? "Date" : FILE_SORT_LABELS[key],
  accessibilityLabel: `Sort by ${FILE_SORT_LABELS[key].toLocaleLowerCase()}`,
}));

function directionOptions(key: FileSortKey) {
  const first = defaultSortDirection(key);
  const second: FileSortDirection = first === "asc" ? "desc" : "asc";
  return [first, second].map((direction) => ({
    value: direction,
    label: FILE_SORT_DIRECTION_LABELS[key][direction],
  }));
}

/**
 * How this device shows folders: the order, whether folders sit on top, and
 * whether hidden files show. Changes apply at once and to every folder.
 */
export function ViewOptionsSheet({
  visible,
  sort,
  foldersFirst,
  showHidden,
  onSortChange,
  onFoldersFirstChange,
  onShowHiddenChange,
  onDismiss,
}: ViewOptionsSheetProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Sheet onDismiss={onDismiss} testID="file-view-options" visible={visible}>
      <SheetHeader title="View options" />
      <View style={{ gap: theme.space(4), padding: theme.space(4) }}>
        <View style={{ gap: theme.space(2) }}>
          <Text color="mutedForeground" variant="caption">
            Sort by
          </Text>
          <SegmentedControl
            accessibilityLabel="Sort by"
            onChange={(key) => onSortChange({ key, direction: defaultSortDirection(key) })}
            options={SORT_FIELD_OPTIONS}
            value={sort.key}
          />
          <SegmentedControl
            accessibilityLabel="Sort order"
            onChange={(direction) => onSortChange({ key: sort.key, direction })}
            options={directionOptions(sort.key)}
            value={sort.direction}
          />
        </View>
        <View style={[styles.switchRow, { gap: theme.space(3) }]}>
          <View style={styles.switchCopy}>
            <Text variant="label">{FOLDERS_ON_TOP_LABEL}</Text>
            <Text color="mutedForeground" variant="caption">
              Keep folders above files, whichever way the list is sorted.
            </Text>
          </View>
          <Switch
            accessibilityLabel={FOLDERS_ON_TOP_LABEL}
            onValueChange={onFoldersFirstChange}
            value={foldersFirst}
          />
        </View>
        <View style={[styles.switchRow, { gap: theme.space(3) }]}>
          <View style={styles.switchCopy}>
            <Text variant="label">{SHOW_HIDDEN_LABEL}</Text>
            <Text color="mutedForeground" variant="caption">
              Include files and folders whose names begin with a dot.
            </Text>
          </View>
          <Switch
            accessibilityLabel={SHOW_HIDDEN_LABEL}
            onValueChange={onShowHiddenChange}
            value={showHidden}
          />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  switchCopy: { flex: 1 },
  switchRow: { alignItems: "center", flexDirection: "row" },
});
