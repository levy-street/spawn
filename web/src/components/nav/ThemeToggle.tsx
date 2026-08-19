"use client";

import { Check, Monitor, Moon, Sun } from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useRef,
} from "react";
import { IconSlot, RowLabel, rowClass } from "@/components/nav/sidebar-row";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  type DropdownMenuHandle,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { RailTooltip } from "@/components/ui/tooltip";
import { type ResolvedTheme, type ThemePreference, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** Held longer than this and the press opens the menu instead of toggling. */
const LONG_PRESS_MS = 450;

const OPTIONS: Array<{
  value: ThemePreference;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/**
 * One-tap light/dark on chrome that is always on screen.
 *
 * The glyph is the theme you would switch *to*, and the accessible name says
 * the same thing, so the icon and the label can never disagree. A tap only
 * ever writes `light` or `dark`: cycling all three makes the next tap
 * unpredictable, which is the thing that makes a one-tap control not worth
 * tapping.
 *
 * "System" is therefore not on the tap — it is on the menu, reached by
 * long-press, right-click, or ArrowDown. Settings -> Appearance stays the
 * authoritative three-way control and reflects whatever this sets, since both
 * write the same store.
 */
export function ThemeToggle({
  variant = "icon",
  collapsed = false,
  className,
}: {
  /** `icon` for the mobile top bar; `row` for the desktop sidebar rail. */
  variant?: "icon" | "row";
  /** Rail state, `row` only — the label fades out but the icon holds still. */
  collapsed?: boolean;
  className?: string;
}) {
  const { preference, resolved, setPreference } = useTheme();
  const menu = useRef<DropdownMenuHandle>(null);
  const longPress = useRef<number | null>(null);
  // A long press ends in a click too; without this the menu would open and
  // the theme would flip underneath it.
  const openedByLongPress = useRef(false);

  const next: ResolvedTheme = resolved === "dark" ? "light" : "dark";
  const actionLabel = `Switch to ${next} theme`;
  const NextIcon = next === "light" ? Sun : Moon;
  const hint =
    preference === "system"
      ? `${actionLabel} · following system (${resolved})`
      : `${actionLabel} · hold for more`;

  const cancelLongPress = () => {
    if (longPress.current === null) return;
    window.clearTimeout(longPress.current);
    longPress.current = null;
  };

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    const { clientX, clientY } = event;
    openedByLongPress.current = false;
    cancelLongPress();
    longPress.current = window.setTimeout(() => {
      longPress.current = null;
      openedByLongPress.current = true;
      menu.current?.openAt(clientX, clientY);
    }, LONG_PRESS_MS);
  };

  const triggerProps = {
    onPointerDown,
    onPointerUp: cancelLongPress,
    onPointerLeave: cancelLongPress,
    onPointerCancel: cancelLongPress,
    onContextMenu: (event: { preventDefault: () => void; clientX: number; clientY: number }) => {
      event.preventDefault();
      openedByLongPress.current = true;
      menu.current?.openAt(event.clientX, event.clientY);
    },
    onClick: () => {
      if (openedByLongPress.current) {
        openedByLongPress.current = false;
        return;
      }
      setPreference(next);
    },
  };

  const wrap = (children: ReactNode) =>
    variant === "row" ? (
      <RailTooltip label={hint} disabled={!collapsed}>
        {children}
      </RailTooltip>
    ) : (
      children
    );

  return (
    <DropdownMenu
      ref={menu}
      side={variant === "row" ? "top" : "bottom"}
      align={variant === "row" ? "start" : "end"}
      className={cn(variant === "row" && "block w-full", className)}
      menuClassName="w-48"
      renderTrigger={(props) =>
        wrap(
          <button
            type="button"
            data-testid="theme-toggle"
            aria-label={actionLabel}
            title={variant === "row" && collapsed ? undefined : hint}
            aria-haspopup="menu"
            aria-expanded={props["aria-expanded"]}
            aria-controls={props["aria-controls"]}
            onKeyDown={props.onKeyDown}
            {...triggerProps}
            className={
              variant === "row"
                ? rowClass(false)
                : cn(buttonVariants({ variant: "ghost", size: "icon" }), "touch-manipulation")
            }
          >
            {variant === "row" ? (
              <>
                <IconSlot>
                  <NextIcon className="size-4" aria-hidden />
                </IconSlot>
                {/* Says the action, not the state: a row reading "Dark" next
                    to a moon is ambiguous about which one you are in. The
                    accessible name adds "theme" and so still contains this. */}
                <RowLabel collapsed={collapsed}>Switch to {next}</RowLabel>
              </>
            ) : (
              <NextIcon className="size-4.5" aria-hidden />
            )}
          </button>,
        )
      }
    >
      <DropdownMenuLabel>Theme</DropdownMenuLabel>
      <DropdownMenuSeparator />
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <DropdownMenuItem key={value} onSelect={() => setPreference(value)}>
          <Icon className="size-4" aria-hidden />
          <span className="flex-1">{label}</span>
          {preference === value && <Check className="size-3.5 text-muted-foreground" aria-hidden />}
        </DropdownMenuItem>
      ))}
    </DropdownMenu>
  );
}
