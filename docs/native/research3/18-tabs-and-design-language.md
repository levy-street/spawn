# R18 — Workspace tabs, list parity, and the native design language

## TL;DR
1. Web tabs are 32 px-high, 160 px-minimum pills in a 44 px strip; the active tab becomes a 38 px connected foot, while inactive tabs remain visibly separated by 6 px shell gutters.
2. The web treatment uses fill and geometry—not an outline or underline—to define state: active `tab-surface`, translucent inactive fill, 8 px top radii, and 6 px concave joins into the pane.
3. Every closable web tab exposes an 18 × 18 close control with a 12 px X; closing a tab with sessions requires destructive confirmation and kills every session before removing the tab.
4. Web reorder is optimistic, persists the whole layout, keeps the active tab active, and uses neighbor-midpoint crossing; new tabs append and activate, while closing an active tab selects its nearest predecessor.
5. Native should use 160 px tabs, direct 44 × 44 close targets, horizontal overflow, and a 300 ms long-press-then-drag interaction with pickup/index/drop haptics and edge auto-scroll.
6. The eight-tab ceiling is a server/domain rule, not a visual suggestion; the add-tab control must disable at eight and explain the limit accessibly.
7. The owner's “full width add” request belongs to the pane/workspace lists: replace their small centered/header actions with full-width 48–56 pt controls and make primary rows 72 pt tall.
8. OpenAI's current product language is restrained, neutral, hierarchy-led, rounded without being bubbly, and sparing with accent colour; exact product metrics are not publicly specified and are marked `UNKNOWN:` below.
9. spawn should not copy OpenAI Sans or invent new tokens; it should use its existing 4 pt rhythm, neutral semantic palette, radii, type roles, and swift motion more consistently.
10. The canonical native system below standardises list rows, headers, cards, fields, footer bars, menus, sheets, empty/error states, and badges with explicit anatomy, metrics, interaction states, and accessibility behavior.

## Scope and evidence rules

This report treats `web/` as the visual and behavioral source of truth, then adapts its composition to a phone. Values called **measured** below come directly from source. OpenAI product observations were checked against current official pages on 2026-08-22; where OpenAI does not publish a numeric product specification, the observation is explicitly an inference and the metric is **UNKNOWN:** rather than reverse-engineered from a marketing screenshot.

The relevant installed native versions are Expo `54.0.37`, React Native `0.81.5`, `react-native-gesture-handler` `~2.28.0`, `react-native-reanimated` `~4.1.1`, and `expo-haptics` `~15.0.8` (`mobile/package.json:33`, `mobile/package.json:59`, `mobile/package.json:61`, `mobile/package.json:63`, `mobile/package.json:42`). No new dependency is needed or recommended.

---

## Part A — workspace tabs and list parity

## 1. What the web tab strip actually renders

### 1.1 Strip geometry and overflow

The strip is a one-line horizontal rail:

```tsx
<div className="flex h-11 shrink-0 items-end gap-1.5 overflow-x-auto bg-shell pr-1.5 pb-1.5">
```

That means (`web/src/components/workspace/workspace-tabs.tsx:822`):

| Property | Web value | Consequence |
|---|---:|---|
| Rail height | `h-11` = 44 px | Tabs sit at the bottom of a fixed chrome band. |
| Inter-tab gap | `gap-1.5` = 6 px | Shell remains visible between inactive tabs; this is the main separator. |
| Right/bottom inset | `pr-1.5 pb-1.5` = 6 px | A resting 32 px tab sits 6 px above the pane; a connected active tab consumes that foot. |
| Overflow | `overflow-x-auto` | Tabs never wrap or compress below their minimum width; the rail scrolls horizontally. |
| Rail background | `bg-shell` | The 6 px gutters contrast against tab fills. |

There is intentionally no leading spacer before the first tab. The plus and settings controls are additional shrink-free children at the end of the same rail (`web/src/components/workspace/workspace-tabs.tsx:974`, `web/src/components/workspace/workspace-tabs.tsx:1048`).

### 1.2 Exact resting tab treatment

The common tab classes are:

```tsx
"flex h-8 min-w-40 items-center gap-1.5 rounded-md pl-3 text-xs font-medium",
canClose ? "pr-6.5" : "pr-3.5"
```

from `web/src/components/workspace/workspace-tabs.tsx:865`. The measured anatomy is:

| Property | All web tabs |
|---|---|
| Resting visual height | 32 px |
| Minimum width | 160 px |
| Corner radius | `rounded-md` = 8 px (`web/src/app/globals.css:91`) |
| Left padding | 12 px |
| Right padding | 26 px when closeable; 14 px for the sole non-closeable tab |
| Internal gap | 6 px |
| Label | 12 px, 16 px line height, weight 500 (`text-xs font-medium`) |
| Border | None |
| Underline | None |
| Truncation | Single-line ellipsis; the tab itself remains at least 160 px |

The inactive state is `bg-background/40 text-muted-foreground`, becoming `bg-background/60 text-foreground` on hover (`web/src/components/workspace/workspace-tabs.tsx:927`). The active state is `bg-[var(--tab-surface)] text-foreground` (`web/src/components/workspace/workspace-tabs.tsx:918`). `--tab-surface` is contextual: empty/background when no pane header is attached, or a 75% card/background mix when the active tab is connected to pane content; an unfocused terminal uses the dimmer surface (`web/src/components/workspace/workspace-tabs.tsx:920`).

**RECOMMEND:** do not add a decorative outline or active underline on native. The web tabs feel “defined” because the shell-colored 6 px gutters separate filled shapes and the selected shape physically joins its content. Preserve that visual grammar.

### 1.3 The active connected tab

When the active tab has content under it, the active tab gains:

```tsx
"tab-connected -mb-1.5 h-[38px] rounded-b-none pb-1.5"
```

at `web/src/components/workspace/workspace-tabs.tsx:923`. It becomes 38 px tall, moves 6 px into the rail's bottom inset, loses its bottom radii, and uses 6 px bottom padding so its label remains aligned with resting tabs. The CSS creates two 6 × 6 concave extensions:

```css
.tab-connected::before,
.tab-connected::after {
  bottom: 0;
  width: 6px;
  height: 6px;
  background-color: var(--tab-surface);
}
.tab-connected::before { left: -6px; /* radial mask */ }
.tab-connected::after  { right: -6px; /* radial mask */ }
```

(`web/src/app/globals.css:526`, `web/src/app/globals.css:529`, `web/src/app/globals.css:539`, `web/src/app/globals.css:544`). This is the web's selected indicator: it is a connected sheet, not a line.

An attention badge can precede the label. It uses the warning treatment, 6 px horizontal padding, and 10/16 typography; a badged tab reduces its left padding from 12 to 8 px (`web/src/components/workspace/workspace-tabs.tsx:936`). Native does not need to invent an attention state until its domain exposes the same signal.

## 2. Close behavior is direct, visible, and destructive when necessary

### 2.1 Affordance

`canClose` is true whenever there is more than one tab (`web/src/components/workspace/workspace-tabs.tsx:790`). Each closeable tab therefore shows an always-present, independently interactive close button—not a hover-only icon and not a menu command:

```tsx
<button
  className="absolute right-1.5 top-1/2 flex size-4.5 -translate-y-1/2 items-center justify-center rounded-sm ..."
  aria-label={`Close ${tab.name}`}
>
  <XIcon className="size-3" />
</button>
```

(`web/src/components/workspace/workspace-tabs.tsx:943`). Its measured box is 18 × 18 px, the X is 12 px, its right inset is 6 px, and its radius is 6 px. The tab reserves 26 px at the right so the label cannot run underneath it.

### 2.2 What closing means

The close path first computes the next layout with `removeTab`, then inspects every non-widget tile in the closing tab (`web/src/components/workspace/workspace-tabs.tsx:675`).

- With no live sessions, it patches the next layout directly.
- With one or more sessions, it presents a destructive confirmation named `Close {tab.name}?`; the message states that the sessions will close and their processes will be killed (`web/src/components/workspace/workspace-tabs.tsx:681`).
- Acceptance removes all sessions with `Promise.allSettled` before patching the layout (`web/src/components/workspace/workspace-tabs.tsx:688`). If any removal fails, it reports the error and does not patch away the tab (`web/src/components/workspace/workspace-tabs.tsx:694`).
- Widget tiles have no remote process and simply disappear with the tab.
- The last tab cannot close. If the active tab closes, the closest surviving predecessor becomes active (`web/src/lib/tabs.ts:190`).

Native already follows the important destructive rule: `deleteTab` collects every non-widget session, deletes them, invalidates sessions, and only then commits the reduced layout (`mobile/src/components/workspace-detail/use-workspace-actions.ts:91`). Its confirmation also says every session will be killed and deleted (`mobile/src/components/workspace-detail/workspace-detail.tsx:300`). What is missing is the visible X; close currently lives behind the tab action sheet (`mobile/src/components/workspace-detail/action-sheets.tsx:165`).

**RECOMMEND:** expose the X on every tab when `tabs.length > 1`. Use a 14 px X centered in a 44 × 44 pt native hit target, with `accessibilityLabel="Close {name}"` and no label overlap. Tap X must not select the tab first. Keep the existing destructive confirmation and session-first deletion. If a deletion fails, keep the tab, show the canonical inline error, and leave retry possible.

## 3. Web drag reorder, persistence, and ordering rules

### 3.1 Pointer algorithm

Web begins a possible drag on pointer-down, measures all tab rectangles and their gaps, and waits for 4 px of travel before declaring a drag (`web/src/components/workspace/workspace-tabs.tsx:330`, `web/src/components/workspace/workspace-tabs.tsx:85`). The dragged tab follows the pointer. The destination changes when:

- moving left: the dragged tab's leading edge passes the previous tab's midpoint;
- moving right: the dragged tab's trailing edge passes the next tab's midpoint.

Passed siblings translate by one measured tab-plus-gap slot and use `transform 150ms ease-out`; the dragged tab remains above them (`web/src/components/workspace/workspace-tabs.tsx:416`). Destination is clamped to the first/last index. Escape cancels (`web/src/components/workspace/workspace-tabs.tsx:501`). `Alt+Shift+ArrowLeft/Right` provides a keyboard reorder path (`web/src/components/workspace/workspace-tabs.tsx:888`).

The web deliberately ignores touch pointers in this desktop implementation (`web/src/components/workspace/workspace-tabs.tsx:523`), so its exact activation gesture is not a phone precedent. Its geometry and persistence semantics are the precedent.

Holding a platform modifier during the desktop drag duplicates rather than moves and shows a dashed ghost (`web/src/components/workspace/workspace-tabs.tsx:459`, `web/src/components/workspace/workspace-tabs.tsx:959`). **RECOMMEND:** omit drag-to-duplicate on phone; there is no discoverable or reliable one-finger equivalent. If duplication is later required, put it in the tab action sheet.

### 3.2 Persistence

On drop, web derives the reordered layout, holds that order locally for one animation frame to avoid a snap-back, and patches the whole workspace layout (`web/src/components/workspace/workspace-tabs.tsx:295`). The mutation is optimistic and has rollback/error handling through the layout patch path (`web/src/components/workspace/workspace-tabs.tsx:209`). Transient pixel transforms are never persisted; only the resulting tab array order is.

`reorderTab` removes the requested tab and inserts it at a clamped destination. Unknown IDs and no-op destinations return null; all other layout fields, including `active_tab`, remain unchanged (`web/src/lib/tabs.ts:211`). Native's pure helper has the same core semantics (`mobile/src/data/layout/tabs.ts:72`), and `useWorkspaceActions` already schedules optimistic reorder persistence, but its public action currently accepts only an adjacent `-1 | 1` offset (`mobile/src/components/workspace-detail/use-workspace-actions.ts:86`).

**RECOMMEND:** change that internal action during the fix batch to accept a final absolute `toIndex`, run the existing `reorderTab(layout, tabId, toIndex)`, and call the existing scheduled layout reorder once on drop. Do not issue a network mutation for every crossed index.

### 3.3 Stable ordering rules that native must preserve

| Operation | Canonical rule | Evidence |
|---|---|---|
| Add | Append at the end and activate the new tab. | `web/src/lib/tabs.ts:125`; native already matches at `mobile/src/data/layout/tabs.ts:35`. |
| Duplicate | Insert at the requested clamped position (or the end), activate the copy, and refuse at eight. | `web/src/lib/tabs.ts:148`; web's pointer modifier supplies the insertion position. |
| Default name | Start at `tabs.length + 1`; skip an already-used `Tab N`. | `web/src/lib/tabs.ts:117`; native matches at `mobile/src/data/layout/tabs.ts:28`. |
| Reorder | Move only the chosen array element; keep `active_tab` unchanged. | `web/src/lib/tabs.ts:211`; native matches at `mobile/src/data/layout/tabs.ts:72`. |
| Close inactive | Preserve the current active tab. | `web/src/lib/tabs.ts:190`. |
| Close active | Prefer the nearest surviving predecessor; fall back to the first tab. | `web/src/lib/tabs.ts:196`; native matches at `mobile/src/data/layout/tabs.ts:96`. |
| Last tab | Never close it. | `web/src/lib/tabs.ts:190`; native checks at `mobile/src/data/layout/tabs.ts:88`. |
| Maximum | Never exceed eight tabs. | `web/src/lib/tabs.ts:42`; native checks at `mobile/src/data/layout/tabs.ts:11`. |

## 4. Add-tab, overflow, and the eight-tab ceiling

Web's add-tab control is a compact trailing plus: 28 × 28 px, 14 px icon, aligned with a 2 px bottom margin. It disables while a layout patch is pending or at `MAX_TABS` (`web/src/components/workspace/workspace-tabs.tsx:974`). Web appends and activates the new empty tab (`web/src/components/workspace/workspace-tabs.tsx:602`). Because tabs are `shrink-0` and the rail is `overflow-x-auto`, the strip scrolls at narrow widths rather than shrinking, wrapping, or turning tabs into a dropdown.

The implementation has no hidden-tab overflow menu and no programmatic selected-tab scroll routine: the browser's horizontal overflow is the only overflow mechanism (`web/src/components/workspace/workspace-tabs.tsx:822`). The trailing ellipsis after the plus is workspace/settings chrome, not a list of hidden tabs (`web/src/components/workspace/workspace-tabs.tsx:1048`).

The eight-tab ceiling is not an arbitrary UI choice. Prior protocol/domain research records that the server accepts at least one and at most eight tabs (`docs/native/research/07-workspace-model.md:63`), and calls it one of only two actual layout ceilings (`docs/native/research/07-workspace-model.md:5`). Both implementations encode `MAX_TABS = 8` (`web/src/lib/tabs.ts:42`, `mobile/src/data/layout/tabs.ts:11`).

**RECOMMEND:** native keeps a compact trailing add-tab control, adapted to a 44 × 44 pt touch target with a 16 px plus. It remains the last item inside the horizontally scrollable strip, disables at eight or while creation is pending, uses `accessibilityLabel="New tab"`, and exposes `accessibilityHint="A workspace can have up to 8 tabs"` while disabled. A successful add scrolls the new active tab fully into view with 12 pt breathing room.

The owner's “add button should be full width” refers to the list-level Add action, not this tab-rail affordance: the web itself uses a compact plus for tabs but a full-width row-shaped “New workspace” control in the sidebar (`web/src/components/nav/Sidebar.tsx:343`, `web/src/components/nav/Sidebar.tsx:464`). Native's pane list currently centers a small `size="sm"` Add button in both empty and footer states (`mobile/src/components/workspace-detail/pane-list.tsx:107`, `mobile/src/components/workspace-detail/pane-list.tsx:119`). See §8 for the required list treatment.

## 5. Current native tab strip: exact delta

Native currently uses `TAB_WIDTH = 96`, `TAB_GAP = 6`, and `TAB_STEP = 102` (`mobile/src/components/workspace-detail/tab-strip.tsx:12`). A 44 pt wrapper contains a 32 pt visual surface; an animated 96 × 32 fill slides behind the active tab (`mobile/src/components/workspace-detail/tab-strip.tsx:50`, `mobile/src/components/workspace-detail/tab-strip.tsx:68`). Labels are 14/20; selected labels are semibold while inactive labels are normal (`mobile/src/components/workspace-detail/tab-strip.tsx:106`).

Functional delta:

| Requirement | Current native | Target |
|---|---|---|
| Definition | One sliding active pill; inactive surfaces are faint and only 96 pt wide. | Separate 160 pt filled tab shapes with 6 pt gutters; active tab joins pane. |
| Close | Hidden in long-press action sheet. | Direct X on every closable tab; destructive confirmation only when needed. |
| Reorder | Long press emits medium haptic and opens Move left/Move right actions (`mobile/src/components/workspace-detail/tab-strip.tsx:89`). | Long-press pickup followed by continuous drag; keep action-sheet steps as accessibility fallback. |
| Add | Small 36 pt icon control (`mobile/src/components/workspace-detail/tab-strip.tsx:132`). | 44 pt control; visibly disabled/busy at ceiling; scroll new tab into view. |
| Overflow | `ScrollView` and active-index scroll already exist (`mobile/src/components/workspace-detail/tab-strip.tsx:43`). | Retain horizontal scrolling; calculate visibility from measured widths and scroll offset. |
| Width | Fixed 96 pt makes names and close affordance compete. | 160 pt fixed/minimum phone target matching web; ellipsize label before X. |
| Active semantics | Moving indicator can read as a segmented control. | Connected active sheet, like the web workspace. |

The native plus is wired to `actions.createTab` (`mobile/src/components/workspace-detail/workspace-detail.tsx:225`), so the owner's report that it “does nothing” is not explained by a missing callback in `TabStrip`. The fix pass must verify pending/error/disabled feedback and the mutation path; this report does not claim a root cause. **UNKNOWN:** the observed device's request/response and operation error were not captured in the repository.

## 6. Decisive native tab specification

### 6.1 Resting layout

**RECOMMEND:** implement these values using existing tokens; do not add a tab-specific palette.

| Element | Native target |
|---|---|
| Strip | 52 pt high; background `shell`; bottom-align children; 6 pt item gap; 6 pt bottom inset; horizontal scroll; no wrap. |
| Tab width | 160 pt fixed for the first pass. Fixed width makes reorder math deterministic and matches the web minimum. |
| Inactive visual | 40 pt high, radius 8 (`radii.md`), `surfaces.dimmed`, no border, text `mutedForeground`. |
| Active empty visual | 40 pt high, radius 8, `tabSurfaces.empty`, text `foreground`. |
| Active connected visual | 46 pt high: same 40 pt label plane plus a 6 pt bottom foot; top radii 8, bottom radii 0; `tabSurfaces.focused` or `.dimmed` according to pane focus. |
| Connected join | Two 6 × 6 corner patches/masks flanking the foot where feasible; otherwise a straight 6 pt foot spanning the tab is acceptable for the first fix. Never substitute an underline. |
| Label | 14/20, weight 500 for both states; one line; tail ellipsis. State comes from fill, foreground, and connection, not a gratuitous weight jump. |
| Label padding | Left 12; right 44 when closeable, otherwise 14; internal badge gap 6. |
| Close | Absolute right 0 within tab; 44 × 44 hit target; X 14; visual hover is irrelevant; pressed fill `accent`; radius 6; `hitSlop` is not a substitute for the real target. |
| Add | 44 × 44; plus 16; radius 8; pressed `accent`; disabled opacity 0.5; busy spinner 16. |
| Motion | 150 ms sibling displacement and settle using existing `motion.easing.out`; 200 ms pickup/drop if scale is used; immediate under Reduce Motion. |

At 160 pt, two tabs will not fit side by side on most phones. That is intentional: tab identity, closeability, and readable names take precedence over showing a compressed count. Keep 12 pt of the adjacent tab visible when programmatically revealing the active tab, where the viewport permits; that glimpse teaches horizontal overflow.

### 6.2 Long-press-then-drag interaction

**RECOMMEND:** use RNGH's declarative pan gesture and Reanimated shared values; both are already installed. The complete phone interaction is:

1. **Rest:** a horizontal finger movement scrolls the strip normally. A tap selects. The X closes without selecting.
2. **Hold:** `Gesture.Pan().activateAfterLongPress(300)` waits 300 ms. RNGH documents that movement during the waiting period causes the pan to fail, allowing the native scroll interaction to win; the API is documented at [RNGH Pan gesture](https://docs.swmansion.com/react-native-gesture-handler/docs/gestures/use-pan-gesture/).
3. **Pickup:** on activation, freeze strip scrolling, snapshot tab frames and `scrollX`, raise the dragged tab above siblings, animate it to scale `1.02` with the existing small elevation, and emit one medium impact. Do not resize the layout slot.
4. **Track:** derive content-space X as `absoluteX - stripWindowLeft + scrollX`. Translate the dragged tab on the UI thread. Port the web crossing rule exactly: moving left claims a predecessor when the dragged leading edge crosses that predecessor's midpoint; moving right claims a successor when its trailing edge crosses that successor's midpoint. Clamp `toIndex` to `[0, tabs.length - 1]`.
5. **Make room:** each passed sibling translates exactly one `TAB_WIDTH + TAB_GAP` = 166 pt slot in the opposite direction, using a 150 ms timing. The source slot is visibly occupied by the shifted sequence; do not reorder React children on every frame.
6. **Indicate drop:** render a 2 pt-wide, 28 pt-high `ring`-coloured vertical insertion bar centered in the 6 pt gap at the current boundary. Before-first and after-last use the relevant outer edge. The bar follows the computed destination; it does not sit under the dragged card.
7. **Index haptic:** emit `selection()` once each time `toIndex` changes. The existing wrapper suppresses repeats within 50 ms (`mobile/src/lib/haptics.ts:15`), preventing an edge-scroll buzz.
8. **Edge auto-scroll:** when the pointer enters a 48 pt band at either viewport edge, start a UI-thread frame callback. Speed increases linearly from 0 at the band's inner edge to 720 pt/s at the outer edge; clamp scroll offset to `[0, contentWidth - viewportWidth]`. Call `scrollTo(animatedRef, x, 0, false)` each frame, then recompute destination from the new `scrollX`. Reanimated documents synchronous UI-thread `scrollTo` and iOS support at [Reanimated `scrollTo`](https://docs.swmansion.com/react-native-reanimated/docs/scroll/scrollTo/), and per-frame UI-thread work at [Reanimated `useFrameCallback`](https://docs.swmansion.com/react-native-reanimated/docs/advanced/useFrameCallback/).
9. **Drop:** stop the frame callback, restore scrolling, emit one light impact, and bridge only the final `{tabId, toIndex}` to JS. Apply `reorderTab` and schedule one optimistic whole-layout patch. Active identity stays the same.
10. **Cancel/failure:** cancellation, gesture failure, or an unchanged destination returns the tab to zero translation and sends no mutation. A persistence failure rolls back through the existing reorder mechanism and shows the canonical inline error; never leave the visual order ahead of stored order.

The drop indicator uses neutral `ring`, not blue/green/warning: it indicates a structural destination, not status. Auto-scroll speed is a native implementation target, not a web measurement.

### 6.3 Gesture coordination and accessibility

- While waiting for 300 ms, early horizontal motion must remain ordinary strip scrolling. Once pickup activates, set the strip `scrollEnabled={false}` and let the UI-thread edge loop own scrolling until finalization.
- The gesture is single-pointer. A second pointer cancels; there is no phone duplication modifier.
- Keep Move left and Move right in `TabActionsSheet` for VoiceOver, Switch Control, and a no-drag fallback (`mobile/src/components/workspace-detail/action-sheets.tsx:165`). Disable the impossible direction.
- Expose each tab as `accessibilityRole="tab"`, `accessibilityState={{ selected }}`, label by tab name, and hint “Long press, then drag to reorder.” Expose X as a separate button named “Close {name}.”
- Announce pickup (“Moving {name}, position N of M”), changed positions, successful drop, and cancellation with React Native `AccessibilityInfo.announceForAccessibility`. React Native 0.81 is the core runtime shipped by Expo SDK 54 ([Expo SDK 54 release](https://expo.dev/changelog/sdk-54)); the corresponding core API is documented at [React Native 0.81 AccessibilityInfo](https://reactnative.dev/docs/0.81/accessibilityinfo).
- Under Reduce Motion, keep the same gesture and drop logic but remove scale/elevation travel and use immediate sibling positioning. Haptics remain governed by the app's haptics preference, not by Reduce Motion.

## 7. Verification contract for tabs

The later automated/device pass should prove these behaviors; this is a behavioral contract, not a request to add snapshots of incidental implementation details.

| Case | Expected result |
|---|---|
| One tab | No X; close action absent/disabled; tab can still be selected and renamed. |
| Two tabs | Both X controls visible and 44 pt; inactive close does not switch active before confirmation. |
| Close empty inactive | Removes immediately; active ID unchanged. |
| Close active with sessions | Explicit destructive confirmation; all session deletions succeed before layout removal; predecessor activates. |
| Partial session deletion failure | Tab remains; inline error visible; no false success. |
| Add from 7 | Eighth appends, activates, and scrolls into view. |
| Add at 8 | Control disabled, limit described accessibly, no request emitted. |
| Tap vs scroll vs drag | Tap selects; early movement scrolls; 300 ms hold picks up; X never starts select/drag. |
| Reorder across visible tabs | Siblings open one slot, insertion bar tracks boundary, one persisted mutation fires on drop. |
| Reorder with edge scroll | Holding inside a 48 pt edge band advances scroll smoothly and can reach first/eighth destination. |
| Cancel/no-op | Visual order settles back; no network commit. |
| Persistence rejection | Optimistic order rolls back and canonical error appears. |
| VoiceOver | Tab, selected state, X, Move left/right, positions, drop, and limit are announced. |
| Reduce Motion | No scale/travel flourish; ordering remains usable and deterministic. |

## 8. Workspace and pane lists: the “everything is too small” correction

The current workspace row has a 44 pt touch wrapper around only a 40 pt visual row, with 36 pt leading/action slots (`mobile/src/components/workspace-list/workspace-row.tsx:243`). It tries to fit a 14/20 title plus 12/16 detail into that compact body (`mobile/src/components/workspace-list/workspace-row.tsx:176`). List gaps are only 4 pt (`mobile/src/components/workspace-list/workspace-list-styles.ts:27`). Pane rows similarly bottom out at 56 pt with 12 pt horizontal and 8 pt vertical padding (`mobile/src/components/workspace-detail/terminal-row.tsx:99`, `mobile/src/components/workspace-detail/files-widget-row.tsx:89`).

The web sidebar itself uses full-width row composition: its generic row is 40 px high with a rounded 10 px container (`web/src/components/nav/sidebar-parts.tsx:9`), and “New workspace” is presented with the same full-width row anatomy rather than as a tiny header action (`web/src/components/nav/Sidebar.tsx:343`). A phone should preserve that composition but increase the vertical target for touch and the owner's requested breathing room; a literal 40 px port would repeat the problem.

**RECOMMEND:**

- Workspace and pane entity rows: `minHeight: 72`, horizontal padding 16, vertical padding 12, 12 pt anatomy gap, 8 pt space between rows. Leading workspace mark 40; pane glyph/status group 32–40. Title 14/20 medium or semibold; detail 12/16 regular; trailing action is a real 44 × 44 target. The row may grow for Dynamic Type or wrapped error text; never clip back to 72.
- Workspace list Add: a full-width 56 pt “New workspace” row/button under the section header, horizontal inset 16, leading plus 20, label 14/20 medium, radius 10, neutral border/fill. Remove the small header `size="sm"` button currently at `mobile/src/components/workspace-list/workspace-list-screen.tsx:274`.
- Pane list Add: a full-width 48 pt outline/default button reading “Add terminal or files,” horizontal inset 16, radius 8, plus 16, label 14/20 medium. Use the same control in the empty state and after populated rows; replace the centered small button at `mobile/src/components/workspace-detail/pane-list.tsx:119`.
- List content: 16 pt horizontal screen inset, 12 pt before the first row, 16 pt after the final Add control, and 8 pt row gaps. Do not put every row inside a shadowed card.
- Busy: keep the Add control's width, replace only the leading plus with a 16 pt spinner, retain its label, set `accessibilityState={{ busy: true, disabled: true }}`. Failure appears directly below as the canonical inline error.

This is an intentional correction to the compact target previously proposed in `docs/native/research2/13-styling-parity.md:144`: owner device feedback has higher authority than that paper target. The existing tokens stay intact; composition changes.

---

## Part B — the target design language

## 9. What can responsibly be said about OpenAI's current product language

### 9.1 Primary official evidence

The following sources were checked on 2026-08-22:

- [OpenAI brand guidelines](https://openai.com/brand/) describe a visual idea that combines human warmth/rounded form with technological precision, and describe OpenAI Sans as geometric and functional with a rounded, approachable character. The page lists five weights: Light, Regular, Medium, Semibold, and Bold.
- [ChatGPT visual experience settings](https://help.openai.com/en/articles/11958281) documents light, dark, and system themes plus a separately chosen accent colour used for conversation bubbles, the Voice button, highlighted text, and other interface elements. It also notes that some interface colours retain their own semantics.
- [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt) contains current first-party product captures showing a neutral sidebar, direct “New project” row, named project rows, trailing three-dot actions, restrained selected state, plus-menu actions, and drag-to-project behavior.
- [Official ChatGPT iOS App Store listing](https://apps.apple.com/us/app/chatgpt/id6448311069) and [official ChatGPT download page](https://chatgpt.com/download/) provide current first-party iPhone product captures. These establish the overall product composition, but they do not publish points, CSS tokens, or animation curves.

### 9.2 Evidence, inference, and unknowns

| Property | Responsible characterization | Confidence and consequence for spawn |
|---|---|---|
| Typography | Product screens use a compact, limited hierarchy: regular body, medium/semibold labels and headings, very little gratuitous bold. OpenAI's public brand font has five weights and balances geometry with rounded forms. | Brand weight facts are documented; product scale is visual inference. **UNKNOWN:** exact current ChatGPT iOS point sizes, line heights, tracking, and whether every surface uses the public brand font. Keep spawn's system sans and existing roles. |
| Spacing rhythm | Repeated small gaps establish local groups; larger but restrained breaks separate sections. Rows are aligned around a stable leading/text/trailing anatomy. | Visual inference from official Projects/iOS captures. **UNKNOWN:** OpenAI's numeric spacing tokens. Use spawn's existing 4 pt scale. |
| Corner radii | Controls, composer surfaces, menus, and selected rows are rounded, but ordinary content is not wrapped in a stack of giant rounded cards. | Visual inference. **UNKNOWN:** exact radius values. Use spawn's existing 6/8/10/12/16 scale. |
| Border vs shadow | Separation is mainly background tone, hairline border, whitespace, and overlay scrim. Shadows are quiet and reserved for floating menus/sheets rather than every row. | Visual inference from official product captures. Adopt directly because it agrees with spawn web/tokens. |
| Density | Chrome is compact, while high-frequency touch controls keep comfortable targets. Information is not padded into oversized marketing cards. | Visual inference. On phone, use 44 pt minimum controls and the owner-requested 72 pt entity rows. |
| Colour restraint | Neutral surfaces and text carry most hierarchy; accent is local and user-selectable, while warning/error/success retain semantic colours. | Theme/accent behavior is documented in the visual settings article. Do not spread brand/accent colour across structural chrome. |
| State and hierarchy | Selection is communicated through a controlled surface/foreground change; trailing ellipses disclose secondary actions; primary actions are direct and plainly labeled. | Visible in the official Projects captures. Use more than colour when the state has meaning: connection geometry, labels, icons, or text. |
| List composition | Rows align a leading signifier, primary/secondary text stack, and trailing action/status. Creation actions appear as first-class rows. | Visible in official Projects captures. This directly supports the full-width Add pattern. |
| Motion | The apparent character is short, direct, and spatial: panels enter/leave coherently and direct manipulation tracks input; there is little decorative looping motion. | Visual/product inference. **UNKNOWN:** OpenAI's current durations, springs, easing curves, haptic mapping, and Reduce Motion implementation. Use spawn's defined 100/150/200/220 ms motion. |

**RECOMMEND:** borrow the compositional discipline, not the trademark or font. OpenAI Sans is not a dependency or a design requirement. spawn already has a system sans stack, its own product identity, a web source of truth, and an established semantic token layer (`mobile/src/theme/typography.ts:1`, `docs/native/research/01-design-system.md:355`).

## 10. Reconciliation with spawn's existing language

spawn's underlying token system is already aligned with the useful parts of that language:

- a 4 pt spacing ladder (`mobile/src/theme/spacing.ts:1`);
- radii 6/8/10/12/16 rather than arbitrary per-screen rounding (`mobile/src/theme/spacing.ts:32`);
- neutral semantic light/dark surfaces plus dedicated status colours (`mobile/src/theme/colors.ts:1`);
- system type with 400/500/600 weights and a compact role set (`mobile/src/theme/typography.ts:1`, `mobile/src/theme/typography.ts:85`);
- hairline borders and small/overlay shadows (`docs/native/research/01-design-system.md:254`);
- 100/150/200/220 ms motion and a shared swift curve (`mobile/src/theme/motion.ts:3`, `mobile/src/theme/motion.ts:48`);
- explicit focused/empty/dimmed tab surfaces (`mobile/src/theme/colors.ts:154`).

The problem is inconsistent composition: controls change height and inset from screen to screen, creation actions are mini buttons where the web uses rows, entity rows are cramped, secondary actions are hidden behind inconsistent gestures, and some states are communicated only by a subtle tint. No palette or token redesign is warranted.

**RECOMMEND:** apply these six rules everywhere:

1. **One spacing grammar:** 16 pt screen inset; 24 pt between major sections; 16 pt between fields/blocks; 12 pt inside content clusters; 8 pt between peers; 4 pt only for tightly coupled text/status.
2. **One row grammar:** leading signifier, flexible text stack, optional status, 44 pt trailing target. Full-width creation actions use row grammar too.
3. **One surface grammar:** base screen is flat; cards use a hairline; only floating overlays get an overlay shadow. Avoid cards nested inside cards.
4. **One hierarchy grammar:** title/label weight and foreground establish importance; surface changes establish selection; semantic colour establishes status; icons support rather than replace words.
5. **One action grammar:** direct, frequent actions are visible; secondary/destructive actions live in a native-feeling menu/sheet; destructive execution requires explicit copy when data/processes are affected.
6. **One motion grammar:** 100 ms feedback, 150 ms local rearrangement, 200 ms component transition, 220 ms panel transition; use existing easing; honor Reduce Motion.

## 11. Canonical component standardisation spec

These are build specifications, not option menus. Values use the existing token scale. “Height” is a minimum when Dynamic Type or localization needs more space.

### 11.1 List row

**Use for:** workspaces, panes, sessions, files, selectable destinations, settings summaries.

**Anatomy:** `row container → leading slot → text column → optional status/badge → trailing target`.

| Part | Canonical spec |
|---|---|
| Container | Full available width; `minHeight: 72` for primary entities; radius 10; horizontal padding 16; vertical padding 12; gap 12. Flat by default, no shadow. |
| Leading | 40 × 40 for workspace/avatar; 32 × 32 for glyph/status plate; icon 16–20; radius 8–10. Decorative leading content is hidden from accessibility. |
| Text | Flexible width, `minWidth: 0`; title 14/20 weight 500 or 600; detail 12/16 weight 400 and muted; title/detail gap 2–4; maximum two detail lines before row grows. |
| Trailing | 44 × 44 real target, icon 16–20; or a status label plus a 44 target. Never make a 16 px icon the hit box. |
| Between rows | 8 pt gap. Use a 1 pt separator only in dense settings groups; do not combine separators and floating card gaps. |
| Pressed | Background `accent`; foreground remains legible; 100 ms feedback. |
| Selected | `accent`/selected semantic surface plus foreground change; when selection must survive grayscale, include a check or connected geometry. |
| Disabled | Opacity 0.5, disabled accessibility state, no haptic. |
| Busy | Keep geometry stable; spinner 16 in leading or trailing slot; `busy` and `disabled` accessibility states. |
| Error/stale | Preserve row; show semantic status/badge and optional inline error below. Never delete or collapse the row to signal failure. |

Compact menu/sheet actions are a distinct 44 pt row specified below; they do not reduce primary entities back to 40–56 pt.

### 11.2 Section header

**Anatomy:** `title/detail block → optional trailing action(s)`.

- Container minimum 48 pt, horizontal padding 16, vertical padding 12, gap 8; align first text baselines where possible.
- Title 14/20 semibold. Optional eyebrow/status uses 11/16 medium; optional description uses 12/16 regular muted.
- Trailing icon actions are 44 × 44. A primary creation action is not squeezed into this slot; put its full-width row immediately below.
- Section header has no default background, border, or shadow. Add a bottom hairline only when it remains pinned while content scrolls beneath it.
- Major section-to-section space is 24; header-to-first child is 8.
- Safe-area padding belongs to the screen chrome once. Do not add it again inside each section header.

### 11.3 Card

**Anatomy:** `optional header → content → optional footer`.

| Part | Canonical spec |
|---|---|
| Container | `card` background; radius 10; 1 pt `border`; overflow clipped only when required. |
| Padding | 16 all around; 12 between structural blocks. Header title/description gap 4. |
| Header | Title 16/20 semibold; description 14/20 regular muted; optional 44 pt trailing action. |
| Content | Body 14/20 or 14/24 for prose; internal controls separated by 12–16. |
| Footer | Top gap 16; actions gap 8; one action fills width, two actions share available width equally. |
| Elevation | None when embedded in a list/sheet. Existing small shadow only for a freestanding lifted card; overlay shadow only for actual floating surfaces. |
| Pressed/selectable | 100 ms accent surface. Selected adds semantic selected fill and, only if needed for contrast, a 1 pt ring. |
| Error | Destructive border plus inline error content; no red ambient shadow. |
| Disabled | Opacity 0.5 and no nested action remains tappable. |

Do not nest a card inside another card merely to create spacing; use blocks and dividers.

### 11.4 Form field

**Anatomy:** `label → control → optional helper OR error`.

- Field group gap 6; field-to-field gap 16.
- Label 14/20 medium; required/optional copy is textual and 12/16 muted, not colour-only.
- Control minimum height 44, horizontal padding 12, vertical padding 10 where multiline permits, radius 8, 1 pt `input`/border, background transparent or input semantic surface, text 14/20.
- Placeholder is muted foreground. Leading/trailing icons are 16; a tappable reveal/clear action receives a 44 × 44 target without shrinking text space.
- Focus retains the 1 pt border and adds the existing 1 pt focus ring; do not resize the field. Error swaps border/ring to destructive and shows 12/16 destructive copy below with `accessibilityLiveRegion="polite"`/alert semantics.
- Disabled uses disabled surface/opacity 0.5 and announces disabled. Read-only remains full contrast and announces read-only; it is not styled as disabled.
- Multiline starts at 88 pt (four 20 pt lines plus padding), grows to its screen-specific cap, and scrolls thereafter.

### 11.5 Footer action bar

**Use for:** new workspace Cancel/Create, destructive confirmations with custom content, edit forms that must remain above the keyboard.

**Anatomy:** `optional inline error → equal-width action row → safe-area inset`.

- Anchor to the bottom/keyboard boundary; background `background` or `popover`; 1 pt top border; horizontal padding 16; top padding 12; bottom padding `max(12, safeArea.bottom)` when the keyboard is hidden and 12 when keyboard geometry already excludes the home indicator.
- Action gap 8. One action fills 100%. Two actions each use `flex: 1` and therefore split the available width exactly after the 8 pt gap; minimum height 44, radius 8, label 14/20 medium.
- Cancel/secondary is left; Create/confirm primary is right. Destructive confirm uses destructive treatment only for a destructive operation.
- Loading does not resize the bar: keep label and replace/add a 16 pt spinner; disable both actions while a non-idempotent submit is in flight.
- The scrollable form receives bottom content inset equal to the measured bar height so its last field is never covered.
- Use the installed safe-area and keyboard/core APIs; do not stack screen safe area, navigation inset, footer inset, and arbitrary padding.

This directly answers the owner's new-workspace requirement: Cancel and Create Workspace are 50/50 after the gap and remain stuck above the keyboard.

### 11.6 Menu / popover

**Anatomy:** `optional title → action rows grouped by separators`.

- Width: minimum 176; preferred content width; maximum `viewportWidth - 16`. Terminal menus that contain explanatory text or longer labels should target 280–320, not inherit the minimum.
- Surface `popover`; radius 10; 1 pt `popoverBorder`; existing overlay shadow; outer padding 4.
- Action row minimum 44; horizontal padding 8; vertical padding sufficient to reach 44; gap 8; radius 8; icon 16; label 14/20; shortcut/detail 12/16 muted aligned trailing.
- Pressed/selected row uses `accent`; disabled opacity 0.5; destructive text/icon uses destructive colour and stays in the last separated group.
- Separators are 1 pt with 4 pt vertical and horizontal inset. Do not draw a box around every item.
- Opening action retains accessibility focus; closing returns focus to the invoker. Escape/back closes before navigating the underlying screen.
- A menu is for compact secondary commands. Navigation with meaningful content belongs in a sheet/full overlay with a normal back button, not a too-narrow menu.

### 11.7 Sheet / overlay page

**Anatomy:** `scrim → rounded sheet → drag handle → header/back → scrollable content → optional footer`.

- Phone sheet fills width, top corners radius 16, maximum height `viewportHeight - 40`, background `popover`, 1 pt top/edge border where visible, scrim black at 50%.
- Drag handle 36 × 4, radius 2, centered with 10 pt top and 8 pt bottom space. Header minimum 48, horizontal inset 16, title 14/20 medium or 16/20 semibold, back/close target 44.
- Content inset 16 unless rows intentionally run edge-to-edge; action rows minimum 44; footer follows §11.5 and owns bottom safe area exactly once.
- Entry/exit uses 220 ms panel motion with existing swift/out easing; scrim fades over 150–200 ms. Reduce Motion uses immediate or cross-fade-only state change.
- Modal accessibility traps focus and hides underlying content. System back, visible back/close, scrim tap where safe, and the app's requested full-width interactive dismiss gesture must converge on the same guarded dismissal path.
- Do not call a JavaScript-drawn rectangle “Liquid Glass.” **UNKNOWN:** no verified API in the installed Expo Go SDK 54 dependency set has been identified that can make an arbitrary custom RN menu adopt the native iOS liquid-glass material. Use the canonical restrained popover/sheet until a specific Expo Go-compatible API is verified.

### 11.8 Empty state

**Anatomy:** `optional icon plate → title → explanatory body → primary action → optional secondary link`.

- Container full width; horizontal padding 24; vertical padding 48; centered; gap 12; body maximum width 384.
- Icon plate 48 × 48, radius 12, 1 pt border, icon 20; omit it when it adds no meaning.
- Title 14/20 semibold. Body 14/24 regular muted, one concrete sentence describing what is absent and what the action does.
- Primary CTA has top margin 8 and is full width on phone, minimum 48 pt. An empty pane list uses “Add terminal or files”; an empty workspace list uses “New workspace.”
- Loading is not empty. Error is not empty. Filtered/no-results copy includes a clear-filter action rather than a create action unless creation is truly relevant.

### 11.9 Inline error

Two canonical forms only:

1. **Field error:** 12/16 destructive text directly below its field, optionally preceded by a 12–16 icon. It names the problem and, where useful, the correction.
2. **Operation banner:** full available width; radius 8; 1 pt destructive border; destructive-soft surface; padding 12; gap 8. Leading error icon 16 aligned to the first line; optional title 14/20 semibold; detail 12/16; retry/dismiss is a 44 pt target at the trailing edge or a full-width action row below.

Errors remain near the failed operation, survive long enough to read, use alert/live-region semantics, and never rely on colour alone. Do not use a permanent side stripe, toast-only destructive failure, or raw server text when an actionable sentence can be supplied.

### 11.10 Badge and status

**Badge anatomy:** `optional glyph/dot → short label`.

- Pill radius; 1 pt border; horizontal padding 8; vertical padding 2; gap 4; 11/16 medium; one line.
- Variants use existing neutral, success, warning, destructive, and info semantic pairs. A badge is noninteractive; if it performs an action, build a 44 pt button/chip and give it a verb.
- Keep labels short and explicit: “Offline,” “Starting,” “3 panes.” Never use colour alone.

**Status anatomy:** 8 pt dot + 12/16 label, gap 6. The dot uses semantic status colour; neutral means unknown/idle, not failure. Default animation is none. A brief pulse is allowed only while actively transitioning and stops in a settled state or under Reduce Motion.

### 11.11 Shared control-state matrix

Every shared component must implement only states relevant to it, but must use these semantics consistently:

| State | Surface/foreground | Motion/haptic | Accessibility |
|---|---|---|---|
| Default | Semantic base tokens | None | Correct role and concise label. |
| Pressed | `accent` or variant pressed token | 100 ms; selection/light haptic only for consequential selection, not every row tap | State does not replace label. |
| Focused | Existing 1 pt ring, no layout shift | 100 ms | Visible with keyboard/Switch Control. |
| Selected | Selected/accent surface + foreground; optional check/geometry | 150 ms local transition | `selected: true`. |
| Disabled | Opacity 0.5 and noninteractive | None | `disabled: true`; reason in hint where not obvious. |
| Busy | Stable dimensions; spinner 16 | No repeated haptic | `busy: true`, prevent duplicate submit. |
| Destructive | Destructive text/fill only at decision/action point | Warning haptic only after explicit confirmation if app convention supports it | Action label names the object/effect. |
| Error | Destructive semantic pair plus text/icon | Error haptic once on failed foreground action, never in a loop | Alert/live announcement with recovery. |

## 12. Expo Go SDK 54 compatibility and dependency decision

Every recommended implementation path is compatible with the owner's required runtime:

| Library/API used here | Installed | Expo Go SDK 54 evidence | Decision |
|---|---:|---|---|
| `react-native-gesture-handler` declarative gestures, `activateAfterLongPress` | `~2.28.0` (`mobile/package.json:61`) | Expo's SDK 54 GestureHandler page recommends `~2.28.0`; Expo's [SDK 54 third-party library overview](https://docs.expo.dev/versions/v54.0.0/sdk/third-party-overview/) states listed libraries are built into Expo Go, and links Gesture Handler. See [Expo GestureHandler SDK 54](https://docs.expo.dev/versions/v54.0.0/sdk/gesture-handler/). | Use; no install/config plugin/native rebuild. |
| `react-native-reanimated` shared values, animated refs, `scrollTo`, frame callback | `~4.1.1` (`mobile/package.json:63`) | Expo's [Reanimated SDK 54 page](https://docs.expo.dev/versions/v54.0.0/sdk/reanimated/) recommends `~4.1.1`, says no additional configuration is required, and the third-party overview lists it as built into Expo Go. | Use; no install/config plugin/native rebuild. |
| `expo-haptics` impact/selection | `~15.0.8` (`mobile/package.json:42`) | Expo's [Haptics SDK 54 page](https://docs.expo.dev/versions/v54.0.0/sdk/haptics/) recommends `~15.0.8` and documents the iOS Taptic Engine-backed impact/selection APIs. Expo SDK modules are available to Expo Go at the matching SDK runtime. | Reuse existing wrapper; no install/rebuild. |
| React Native `ScrollView`, `Pressable`, `AccessibilityInfo` | RN `0.81.5` (`mobile/package.json:59`) | [Expo SDK 54](https://expo.dev/changelog/sdk-54) ships React Native 0.81; these are core RN APIs, not native add-ons. | Use; no install/rebuild. |
| `react-native-safe-area-context` | `~5.6.0` (`mobile/package.json:64`) | Expo's [SafeAreaContext SDK 54 page](https://docs.expo.dev/versions/v54.0.0/sdk/safe-area-context/) marks the library included in Expo Go and recommends the SDK-matched package. | Reuse for one-time screen/footer insets; no install/rebuild. |

**RECOMMEND:** add no package. In particular, do not propose a sortable-list package or native iOS material/popover package. The installed RNGH/Reanimated pair is enough for eight fixed-width tabs, and new native dependencies would violate the Expo Go constraint unless already bundled.

## 13. Implementation handoff order

1. Build the canonical row, full-width Add, footer bar, inline error, badge/status, menu, and sheet composition from existing primitives/tokens; do not change token values.
2. Increase workspace/pane entity rows and replace miniature Add placements per §8.
3. Restyle `TabStrip` to the 160 pt filled/connected geometry, add direct close controls, and retain horizontal overflow.
4. Extend the tab action from adjacent offset to absolute destination while preserving the pure helper and optimistic layout scheduler.
5. Add the UI-thread drag preview, insertion bar, haptics, and edge auto-scroll; bridge only final drop.
6. Preserve action-sheet Move left/right and destructive close confirmation as accessibility and failure-safe paths.
7. Verify the contract in §7 on the physical iPhone in Expo Go, including eight tabs, live-session close failure, VoiceOver, Dynamic Type, Reduce Motion, dark mode, and the keyboard-stuck footer.

## 14. Explicit unknowns

- **UNKNOWN:** OpenAI does not publish the exact current ChatGPT iOS/web product type sizes, spacing tokens, radii, shadow recipes, motion durations, easing curves, or haptic mappings. This report does not pretend that inferred values are official.
- **UNKNOWN:** the device-level reason the currently wired native plus appeared to do nothing; no request/response trace accompanies the feedback.
- **UNKNOWN:** whether the web's masked concave tab corners can be reproduced cleanly with the present RN view primitives on every Expo Go iOS version. The straight 6 pt connected foot is the defined fallback and preserves the hierarchy.
- **UNKNOWN:** a verified, general-purpose Apple liquid-glass component API for arbitrary custom menus in Expo Go SDK 54. No new native module is recommended.
- **UNKNOWN:** the owner's preferred long-press dwell after device testing. Start at 300 ms; tune only within 250–350 ms based on false pickups versus perceived delay, without changing the documented interaction model.
