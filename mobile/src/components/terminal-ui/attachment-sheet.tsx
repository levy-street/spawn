import type { AttachmentSource } from "@/components/terminal-ui/use-terminal-transfers";
import { ActionSheet, type ActionSheetAction } from "@/components/ui/action-sheet";
import { Icon } from "@/components/ui/icon";

export interface AttachmentSheetProps {
  visible: boolean;
  onDismiss: () => void;
  onAttach: (source: AttachmentSource) => void;
  onPaste: () => void;
}

/**
 * Everything that puts content the operator already has into the session:
 * clipboard text at the prompt, and the three ways a phone holds a file.
 * Photos land in the session's attachments; anything else beside the work.
 */
export function AttachmentSheet({
  visible,
  onDismiss,
  onAttach,
  onPaste,
}: AttachmentSheetProps): React.JSX.Element {
  const actions: readonly ActionSheetAction[] = [
    {
      id: "camera",
      label: "Take photo",
      icon: <Icon name="Camera" />,
      onPress: () => onAttach("camera"),
    },
    {
      id: "photos",
      label: "Upload from photos",
      icon: <Icon name="ImagePlus" />,
      onPress: () => onAttach("photos"),
    },
    {
      id: "files",
      label: "Upload a file",
      icon: <Icon name="Upload" />,
      onPress: () => onAttach("files"),
    },
    {
      id: "paste",
      label: "Paste clipboard",
      icon: <Icon name="Clipboard" />,
      onPress: onPaste,
    },
  ];

  return <ActionSheet actions={actions} onDismiss={onDismiss} visible={visible} />;
}
