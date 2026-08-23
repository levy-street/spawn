import { ImageSourceSheet } from "@/components/media/image-source-sheet";
import type { AttachmentSource } from "@/components/terminal-ui/use-terminal-transfers";
import type { ActionSheetAction } from "@/components/ui/action-sheet";
import { Icon } from "@/components/ui/icon";

export interface AttachmentSheetProps {
  visible: boolean;
  onDismiss: () => void;
  onAttach: (source: AttachmentSource) => void;
  onPaste: () => void;
}

/**
 * Everything that puts content the operator already has into the session: the
 * three image sources every input in the app offers, plus the clipboard, which
 * only a prompt has any use for.
 */
export function AttachmentSheet({
  visible,
  onDismiss,
  onAttach,
  onPaste,
}: AttachmentSheetProps): React.JSX.Element {
  const paste: readonly ActionSheetAction[] = [
    {
      id: "paste",
      label: "Paste clipboard",
      icon: <Icon name="Clipboard" />,
      onPress: onPaste,
    },
  ];

  return (
    <ImageSourceSheet
      extraActions={paste}
      onDismiss={onDismiss}
      onSelect={onAttach}
      visible={visible}
    />
  );
}
