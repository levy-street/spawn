import type { ImageSource } from "@/components/media/image-source";
import { ActionSheet, type ActionSheetAction } from "@/components/ui/action-sheet";
import { Icon } from "@/components/ui/icon";

export interface ImageSourceSheetProps {
  visible: boolean;
  onDismiss: () => void;
  onSelect: (source: ImageSource) => void;
  /** Extra rows for a caller that offers more than the three image sources. */
  extraActions?: readonly ActionSheetAction[];
}

/**
 * The one drawer every image input opens.
 *
 * Picking a picture used to mean whatever the screen in front of you happened to
 * implement — the terminal offered all three sources, while the workspace and
 * template icons went straight to the file browser, so the camera roll was
 * unreachable for the two inputs most likely to want it. The list lives here now,
 * in one order, with one set of words.
 */
export function ImageSourceSheet({
  visible,
  onDismiss,
  onSelect,
  extraActions = [],
}: ImageSourceSheetProps): React.JSX.Element {
  const actions: readonly ActionSheetAction[] = [
    {
      id: "camera",
      label: "Take photo",
      icon: <Icon name="Camera" />,
      onPress: () => onSelect("camera"),
    },
    {
      id: "photos",
      label: "Upload from photos",
      icon: <Icon name="ImagePlus" />,
      onPress: () => onSelect("photos"),
    },
    {
      id: "files",
      label: "Add from files",
      icon: <Icon name="Upload" />,
      onPress: () => onSelect("files"),
    },
    ...extraActions,
  ];

  return <ActionSheet actions={actions} onDismiss={onDismiss} visible={visible} />;
}
