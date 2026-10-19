import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { DrawerRow } from "@/components/ui/drawer-row";
import { Field } from "@/components/ui/field";
import { FooterActions } from "@/components/ui/footer-actions";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Sheet, SheetHeader, SheetScrollView } from "@/components/ui/sheet";
import { parseHex } from "@/data/color";
import {
  isPresetColor,
  MAX_GROUP_NAME_LENGTH,
  PRESET_COLORS,
  type PresetColor,
  resolveGroupColor,
  type TabGroupPatch,
  UNNAMED_GROUP,
} from "@/data/layout/tab-groups";
import type { TabGroup } from "@/data/types/layout";
import { borderWidth, duration, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

/** How long a name or colour rests before it is saved; the strip shows it at once. */
export const TAB_GROUP_EDIT_DEBOUNCE_MS = duration.progress;

export type TabGroupSheetMode = "create" | "manage";

export interface TabGroupSheetProps {
  visible: boolean;
  /** "create" right after a group is made (Cancel takes it away again); "manage" otherwise. */
  mode: TabGroupSheetMode;
  group: TabGroup | null;
  /** Whether the workspace has room for another tab. */
  canAddTab: boolean;
  /** A name or colour change, already debounced. */
  onUpdate: (groupId: string, patch: TabGroupPatch) => void;
  /** Cancel in create mode: the group just made goes again. */
  onCancel: (group: TabGroup) => void;
  onNewTab: (group: TabGroup) => void;
  onToggleCollapsed: (group: TabGroup) => void;
  onUngroup: (group: TabGroup) => void;
  onDismiss: () => void;
}

function presetLabel(preset: PresetColor): string {
  return `${preset.charAt(0).toUpperCase()}${preset.slice(1)}`;
}

interface SwatchProps {
  color: string;
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
  children?: React.ReactNode;
}

function Swatch({ color, label, selected, onPress, testID, children }: SwatchProps) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={styles.swatchTarget}
      testID={testID}
    >
      <View
        style={[
          styles.swatchRing,
          {
            borderColor: selected ? theme.colors.ring : "transparent",
            borderRadius: theme.radii.pill,
          },
        ]}
      >
        <View style={[styles.swatch, { backgroundColor: color, borderRadius: theme.radii.pill }]}>
          {children}
        </View>
      </View>
    </Pressable>
  );
}

/**
 * A tab group's sheet: its name and colour, applied as they change, and in
 * manage mode what can be done to the group as a whole. Raised by "Add tab to
 * new group" (create) and by holding a group's label (manage).
 */
export function TabGroupSheet({
  visible,
  mode,
  group,
  canAddTab,
  onUpdate,
  onCancel,
  onNewTab,
  onToggleCollapsed,
  onUngroup,
  onDismiss,
}: TabGroupSheetProps) {
  const theme = useTheme();
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(PRESET_COLORS[0]);
  const [customOpen, setCustomOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const pendingRef = useRef<{ groupId: string; patch: TabGroupPatch } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  // The drafts start from the group each time the sheet opens on one.
  if (visible && group && draftFor !== group.id) {
    setDraftFor(group.id);
    setName(group.name);
    setColor(group.color);
    setCustomOpen(!isPresetColor(group.color));
  }
  if (!visible && draftFor !== null) setDraftFor(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const flush = useCallback(() => {
    clearTimer();
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) onUpdateRef.current(pending.groupId, pending.patch);
  }, [clearTimer]);

  const discard = useCallback(() => {
    clearTimer();
    pendingRef.current = null;
  }, [clearTimer]);

  const schedule = useCallback(
    (groupId: string, patch: TabGroupPatch) => {
      const pending = pendingRef.current;
      pendingRef.current = {
        groupId,
        patch: pending?.groupId === groupId ? { ...pending.patch, ...patch } : patch,
      };
      clearTimer();
      timerRef.current = setTimeout(flush, TAB_GROUP_EDIT_DEBOUNCE_MS);
    },
    [clearTimer, flush],
  );

  // Nothing typed is lost to the sheet going away.
  useEffect(() => flush, [flush]);

  const close = () => {
    flush();
    onDismiss();
  };

  const chooseColor = (next: string) => {
    if (!group) return;
    setColor(next);
    schedule(group.id, { color: next });
  };

  const current = group;
  const customColor = isPresetColor(color)
    ? (parseHex(resolveGroupColor(color, theme.colors.tabGroup)) ?? color)
    : color;

  return (
    <Sheet onDismiss={close} testID="tab-group-sheet" visible={visible && group !== null}>
      <SheetHeader title={mode === "create" ? "Create tab group" : "Manage tab group"} />
      <SheetScrollView
        bounces={false}
        keyboardShouldPersistTaps="handled"
        scrollEnabled={!picking}
        testID="tab-group-sheet-scroll"
      >
        <View style={styles.body}>
          <Field label="Name">
            <Input
              maxLength={MAX_GROUP_NAME_LENGTH}
              onChangeText={(text) => {
                setName(text);
                if (current) schedule(current.id, { name: text.trim() });
              }}
              placeholder={UNNAMED_GROUP}
              purpose="plain"
              returnKeyType="done"
              testID="tab-group-name"
              value={name}
            />
          </Field>
          <View accessibilityRole="radiogroup" style={styles.swatches}>
            {PRESET_COLORS.map((preset) => (
              <Swatch
                color={theme.colors.tabGroup[preset]}
                key={preset}
                label={presetLabel(preset)}
                onPress={() => {
                  setCustomOpen(false);
                  chooseColor(preset);
                }}
                selected={!customOpen && color === preset}
                testID={`tab-group-color-${preset}`}
              />
            ))}
            <Swatch
              color={customOpen ? customColor : theme.colors.muted}
              label="Custom"
              onPress={() => {
                setCustomOpen(true);
                // The custom colour starts as the one already shown, so
                // opening the picker changes nothing until it is used.
                if (isPresetColor(color)) chooseColor(customColor);
              }}
              selected={customOpen}
              testID="tab-group-color-custom"
            >
              {customOpen ? null : <Icon color="mutedForeground" name="Palette" />}
            </Swatch>
          </View>
          {customOpen ? (
            <ColorPicker
              onActiveChange={setPicking}
              onChange={chooseColor}
              testID="tab-group-color-picker"
              value={customColor}
            />
          ) : null}
        </View>
        {mode === "manage" && current ? (
          <View>
            <DrawerRow
              disabled={!canAddTab}
              icon={<Icon name="Plus" />}
              label="New tab in group"
              onPress={() => {
                flush();
                onNewTab(current);
                onDismiss();
              }}
              testID="tab-group-new-tab"
              {...(canAddTab ? {} : { detail: "A workspace can have up to 8 tabs" })}
            />
            <DrawerRow
              icon={<Icon name={current.collapsed ? "ChevronDown" : "ChevronsDownUp"} />}
              label={current.collapsed ? "Expand group" : "Collapse group"}
              onPress={() => {
                flush();
                onToggleCollapsed(current);
                onDismiss();
              }}
              testID="tab-group-toggle"
            />
            <DrawerRow
              icon={<Icon name="Unlink" />}
              label="Ungroup tabs"
              onPress={() => {
                discard();
                onUngroup(current);
                onDismiss();
              }}
              testID="tab-group-ungroup"
            />
          </View>
        ) : null}
      </SheetScrollView>
      <FooterActions>
        {mode === "create" ? (
          <Button
            onPress={() => {
              discard();
              if (current) onCancel(current);
              onDismiss();
            }}
            variant="outline"
          >
            Cancel
          </Button>
        ) : null}
        <Button onPress={close}>Done</Button>
      </FooterActions>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: sizing.space.block,
    paddingBottom: sizing.space.block,
    paddingHorizontal: sizing.space.block,
    paddingTop: sizing.space.tight,
  },
  swatch: {
    alignItems: "center",
    height: sizing.colorPicker.swatch,
    justifyContent: "center",
    width: sizing.colorPicker.swatch,
  },
  swatchRing: {
    alignItems: "center",
    borderWidth: borderWidth.emphasis,
    height: sizing.colorPicker.swatch + sizing.space.peer,
    justifyContent: "center",
    width: sizing.colorPicker.swatch + sizing.space.peer,
  },
  swatchTarget: {
    alignItems: "center",
    height: sizing.control.minimumTouchTarget,
    justifyContent: "center",
    width: sizing.control.minimumTouchTarget,
  },
  swatches: {
    columnGap: sizing.space.tight,
    flexDirection: "row",
    flexWrap: "wrap",
  },
});
