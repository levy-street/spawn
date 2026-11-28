"use client";

import { Check, ChevronsDownUp, ChevronsUpDown, Plus, Ungroup } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { DROPDOWN_ITEM_CLASS } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { MenuAnchor } from "@/components/ui/menu-position";
import { Popover } from "@/components/ui/popover";
import { labelTextColor, parseHex } from "@/lib/color";
import { OWN_KEYS_ATTRIBUTE } from "@/lib/keyboard-chords";
import {
  isPresetColor,
  MAX_GROUP_NAME_LENGTH,
  PRESET_COLORS,
  type PresetColor,
} from "@/lib/tab-groups";
import type { TabGroup } from "@/lib/tabs";
import { cn } from "@/lib/utils";

const PRESET_LABELS: Record<PresetColor, string> = {
  blue: "Blue",
  purple: "Purple",
  cyan: "Cyan",
  orange: "Orange",
  yellow: "Yellow",
  pink: "Pink",
  green: "Green",
  gray: "Gray",
  red: "Red",
};

/**
 * How a group colour is painted: a preset from its theme tokens (each theme
 * cuts its own, tuned for the strip it sits on), a custom colour as chosen,
 * with whichever label ink reads better on it.
 */
export function groupColorStyle(color: string): { fill: string; ink: string } {
  if (isPresetColor(color)) {
    return { fill: `var(--tab-group-${color})`, ink: `var(--tab-group-${color}-fg)` };
  }
  const hex = parseHex(color) ?? "#808080";
  return { fill: hex, ink: labelTextColor(hex) };
}

/**
 * The hex a preset is drawn in right now, for a custom colour to start from:
 * choosing Custom on a blue group opens the picker on that blue, not on red.
 * Read from the stylesheet, so it is the theme on screen.
 */
function presetHex(color: PresetColor): string {
  if (typeof document === "undefined") return "#808080";
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(`--tab-group-${color}`)
    .trim();
  return parseHex(value) ?? "#808080";
}

/**
 * Firefox's tab group panel: a name, a colour, and — once the group exists —
 * what can be done with it. Create mode is the panel that opens on a group
 * just made, with Cancel taking the group away again; manage mode is the one a
 * right-click on the label opens.
 *
 * Name and colour apply as they change (the strip debounces the writes), so
 * there is no Save. Escape is Cancel when creating and a plain close when
 * managing; Enter, a press outside, or Done keep what is there.
 */
export function TabGroupEditor({
  mode,
  group,
  anchor,
  canAddTab,
  onEdit,
  onDone,
  onCancel,
  onToggleCollapsed,
  onUngroup,
  onNewTab,
}: {
  mode: "create" | "manage";
  group: TabGroup;
  /** The label's rect; the panel hangs below it. */
  anchor: MenuAnchor;
  /** False at the tab limit (or while a write is in flight). */
  canAddTab: boolean;
  onEdit: (patch: { name?: string; color?: string }) => void;
  /** `restoreFocus` is false for a press elsewhere, which has put the focus
   *  where it wanted it. */
  onDone: (restoreFocus: boolean) => void;
  onCancel: () => void;
  onToggleCollapsed: () => void;
  onUngroup: () => void;
  onNewTab: () => void;
}) {
  const title = mode === "create" ? "Create tab group" : "Manage tab group";
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(false);
  const swatchRefs = useRef(new Map<string, HTMLButtonElement>());
  // The field owns what is typed: the strip's copy of the name comes back a
  // render later, and a field fed from it would lose its caret mid-word.
  const [name, setName] = useState(group.name);
  const custom = !isPresetColor(group.color);
  // Shown once chosen, and kept open while it is in use even if the colour
  // dragged to happens to be the hex of nothing in particular.
  const [pickerOpen, setPickerOpen] = useState(custom);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  /**
   * The name field takes the focus the first time it exists. Not an effect on
   * mount: the popover renders into its portal a commit later, so the field
   * is not there yet when this component's own effects run. And not at once:
   * the popover stays hidden until it has measured itself and been placed,
   * which can take a frame or two (its ResizeObserver runs after animation
   * frames), and a hidden field refuses the focus. So it waits, a frame at a
   * time, for the field to be on show.
   */
  const nameRef = (field: HTMLInputElement | null) => {
    if (!field || focusedRef.current) return;
    focusedRef.current = true;
    let frames = 0;
    const focusWhenShown = () => {
      if (!field.isConnected) return;
      if (getComputedStyle(field).visibility === "hidden" && frames < 30) {
        frames += 1;
        requestAnimationFrame(focusWhenShown);
        return;
      }
      field.focus();
      if (mode === "create") field.select();
    };
    requestAnimationFrame(focusWhenShown);
  };

  // A press anywhere else keeps the group as it stands and closes the panel,
  // as Firefox's does.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      onDoneRef.current(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const choose = (color: string) => {
    if (color === "custom") {
      setPickerOpen(true);
      if (isPresetColor(group.color)) onEdit({ color: presetHex(group.color) });
      return;
    }
    setPickerOpen(false);
    onEdit({ color });
  };

  const swatches = [...PRESET_COLORS, "custom"] as const;
  const checked = pickerOpen || custom ? "custom" : group.color;

  /** Arrow keys walk the radiogroup and choose as they go, the way a radio
   *  group does; Tab leaves it from the chosen swatch. */
  const onSwatchKey = (event: ReactKeyboardEvent, index: number) => {
    const last = swatches.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    const color = swatches[next] as string;
    choose(color);
    swatchRefs.current.get(color)?.focus();
  };

  return (
    <Popover
      open
      anchor={anchor}
      side="bottom"
      align="start"
      interactive
      ariaLabel={title}
      className="w-72 max-w-[calc(100vw-1rem)]"
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: not a control — it only stops the panel's keystrokes from leaving it; every one is handled by the field, radio or slider it was meant for. */}
      <div
        ref={rootRef}
        // The panel's keys are its own: no Alt+digit workspace jump from the
        // name field, no Escape reaching a menu underneath, nothing reaching a
        // terminal. The attribute is what the grid's capture-phase chords
        // read (see keyboard-chords); stopping the bubble covers the rest.
        {...{ [OWN_KEYS_ATTRIBUTE]: "" }}
        data-tab-group-editor={group.id}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            if (mode === "create") onCancel();
            else onDone(true);
          }
        }}
        className="p-3"
      >
        <form
          aria-labelledby={titleId}
          onSubmit={(event) => {
            event.preventDefault();
            onDone(true);
          }}
          className="space-y-3"
        >
          <h2 id={titleId} className="text-sm font-semibold">
            {title}
          </h2>
          <Input
            ref={nameRef}
            aria-label="Group name"
            placeholder="Name"
            value={name}
            maxLength={MAX_GROUP_NAME_LENGTH}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setName(next);
              onEdit({ name: next });
            }}
            className="h-9"
          />
          <div
            role="radiogroup"
            aria-label="Group colour"
            className="flex justify-between gap-1 px-0.5"
          >
            {swatches.map((color, index) => {
              const selected = checked === color;
              const style: CSSProperties =
                color === "custom"
                  ? {
                      backgroundImage: "conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
                    }
                  : { backgroundColor: groupColorStyle(color).fill };
              return (
                // biome-ignore lint/a11y/useSemanticElements: a swatch is a coloured circle with no visible label for an <input type="radio"> to hang one on; a button wearing the radio role is the ARIA radiogroup pattern.
                <button
                  key={color}
                  ref={(element) => {
                    if (element) swatchRefs.current.set(color, element);
                    else swatchRefs.current.delete(color);
                  }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={color === "custom" ? "Custom" : PRESET_LABELS[color]}
                  title={color === "custom" ? "Custom" : PRESET_LABELS[color]}
                  tabIndex={selected ? 0 : -1}
                  data-swatch={color}
                  onClick={() => choose(color)}
                  onKeyDown={(event) => onSwatchKey(event, index)}
                  className={cn(
                    "grid size-5.5 shrink-0 place-items-center rounded-full outline-none transition-shadow",
                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
                    selected && "ring-2 ring-foreground/70 ring-offset-2 ring-offset-popover",
                  )}
                  style={style}
                >
                  {selected && color !== "custom" && (
                    <Check
                      aria-hidden
                      strokeWidth={3}
                      className="size-3.5"
                      style={{ color: groupColorStyle(color).ink }}
                    />
                  )}
                </button>
              );
            })}
          </div>
          {pickerOpen && (
            <ColorPicker
              label="Custom colour"
              value={custom ? group.color : presetHex(group.color as PresetColor)}
              onChange={(hex) => onEdit({ color: hex })}
            />
          )}
          {mode === "create" ? (
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit" size="sm">
                Done
              </Button>
            </div>
          ) : (
            <div className="-mx-1 border-t border-popover-border pt-1">
              <button
                type="button"
                disabled={!canAddTab}
                onClick={onNewTab}
                className={DROPDOWN_ITEM_CLASS}
              >
                <Plus className="size-4" aria-hidden />
                New tab in group
              </button>
              <button type="button" onClick={onToggleCollapsed} className={DROPDOWN_ITEM_CLASS}>
                {group.collapsed ? (
                  <ChevronsUpDown className="size-4" aria-hidden />
                ) : (
                  <ChevronsDownUp className="size-4" aria-hidden />
                )}
                {group.collapsed ? "Expand group" : "Collapse group"}
              </button>
              <button type="button" onClick={onUngroup} className={DROPDOWN_ITEM_CLASS}>
                <Ungroup className="size-4" aria-hidden />
                Ungroup tabs
              </button>
            </div>
          )}
        </form>
      </div>
    </Popover>
  );
}
