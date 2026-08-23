import type { ReactElement, ReactNode } from "react";
import { useRef, useState } from "react";
import { Pressable, type View } from "react-native";

import { Popover, type PopoverAnchorRect, type PopoverSide } from "@/components/ui/popover";
import { Text } from "@/components/ui/text";
import { borderWidth, layer, shadow, useTheme } from "@/theme";

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  side?: PopoverSide;
  delayMs?: number;
  accessibilityLabel?: string;
  disabled?: boolean;
}

export function Tooltip({
  content,
  children,
  side = "right",
  delayMs,
  accessibilityLabel,
  disabled = false,
}: TooltipProps): React.JSX.Element {
  const theme = useTheme();
  const anchorRef = useRef<View>(null);
  const [anchorRect, setAnchorRect] = useState<PopoverAnchorRect | null>(null);
  const [visible, setVisible] = useState(false);
  const contentLabel = typeof content === "string" ? content : accessibilityLabel;

  const open = () => {
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      setAnchorRect({ top: y, bottom: y + height, left: x, right: x + width });
    });
    setVisible(true);
  };

  return (
    <>
      <Pressable
        accessibilityLabel={accessibilityLabel ?? contentLabel}
        accessibilityRole="button"
        collapsable={false}
        delayLongPress={delayMs ?? theme.motion.duration.tooltipDelay}
        disabled={disabled}
        onLayout={(event) => {
          const { x, y, width, height } = event.nativeEvent.layout;
          setAnchorRect({ top: y, bottom: y + height, left: x, right: x + width });
        }}
        onLongPress={open}
        onPressOut={() => setVisible(false)}
        ref={anchorRef}
        {...(contentLabel === undefined ? {} : { accessibilityHint: contentLabel })}
      >
        {children}
      </Pressable>
      <Popover
        align="center"
        animateScale={false}
        contentStyle={{
          backgroundColor: theme.colors.popover,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.md,
          borderWidth: borderWidth.hairline,
          boxShadow: shadow.md,
          paddingHorizontal: theme.space(2),
          paddingVertical: theme.space(1),
        }}
        fallbackWidth={theme.space(64)}
        margin={theme.space(4)}
        maxWidth={theme.space(64)}
        offset={theme.space(2)}
        onDismiss={() => setVisible(false)}
        overlayLayer={layer.tooltip}
        side={side}
        visible={visible}
        {...(contentLabel === undefined ? {} : { accessibilityLabel: contentLabel })}
        {...(anchorRect === null ? { anchorRef } : { anchorRect })}
      >
        {typeof content === "string" ? <Text variant="caption">{content}</Text> : content}
      </Popover>
    </>
  );
}
