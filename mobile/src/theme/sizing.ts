/**
 * Canonical phone sizing for shared UI. Semantic dimensions belong here so a
 * future density adjustment does not require another component sweep.
 */
export const sizing = {
  space: {
    unit: 4,
    tight: 4,
    peer: 8,
    cluster: 12,
    block: 16,
    section: 24,
  },
  screen: {
    gutter: 16,
    regularWidthGutter: 24,
  },
  control: {
    minimumTouchTarget: 44,
    comfortableTouchTarget: 52,
    spinner: 16,
    icon: 20,
    /** A search field stands taller than a plain control: it is the primary
     *  target on the screens it heads, and its text needs room to sit centred. */
    searchField: 48,
    button: {
      sm: 44,
      default: 48,
      lg: 52,
      icon: 48,
    },
    iconButton: {
      default: 44,
      prominent: 48,
    },
  },
  listRow: {
    regular: 64,
    pane: 68,
    rich: 72,
    tall: 76,
    settings: 60,
    horizontalPadding: 16,
    workspaceHorizontalPadding: 12,
    verticalPadding: 12,
    workspaceVerticalPadding: 10,
    contentGap: 12,
    textGap: 2,
    betweenRows: 8,
    leading: {
      glyph: 32,
      workspace: 32,
      pane: 36,
      rich: 40,
    },
    trailingTarget: 44,
    /** Where a full-bleed row separator starts, so it clears the leading slot. */
    separatorInset: 16,
    /** Inset of a row's trailing overflow control from the screen edge. */
    trailingActionInset: 8,
    /** A separator that runs the full width instead of clearing the leading slot. */
    separatorFullBleed: 0,
  },
  sectionHeader: {
    minHeight: 48,
    horizontalPadding: 16,
    verticalPadding: 12,
    contentGap: 8,
    childGap: 8,
  },
  card: {
    padding: 16,
    blockGap: 12,
    copyGap: 4,
    footerGap: 8,
    footerTopGap: 16,
  },
  footer: {
    actionHeight: 48,
    horizontalPadding: 16,
    actionGap: 12,
    topPadding: 12,
    minimumBottomPadding: 12,
  },
  emptyState: {
    horizontalPadding: 24,
    verticalPadding: 48,
    contentGap: 12,
    copyGap: 4,
    actionTopGap: 8,
    bodyMaxWidth: 384,
    iconPlate: 48,
    icon: 20,
    /** The bordered plate every empty state now sits on. */
    containerPadding: 24,
    containerMinHeight: 200,
  },
  /** A bottom drawer's action rows: roomier than a plain list row, since a drawer
   *  is a deliberate stop rather than something you scan past. */
  actionSheet: {
    rowMinHeight: 64,
    verticalPadding: 16,
    horizontalPadding: 20,
    icon: 22,
    /** Clearance between an action's glyph and its label. */
    iconGap: 16,
    iconSlot: 24,
  },
  /** The drawn connection the terminal shows before it has output: two endpoints,
   *  a padlock plate, and the channel closing between them. */
  connectionChannel: {
    endpoint: 6,
    lineWidth: 40,
    lineHeight: 2,
    /** The travelling highlight that says a half is carrying. */
    pulseWidth: 16,
    plate: 36,
    gap: 10,
  },
  sheet: {
    handleWidth: 36,
    handleHeight: 4,
    handleTopPadding: 10,
    handleGap: 8,
  },
  dialog: {
    /** How far a full-page dialog travels on its way in. */
    riseDistance: 72,
  },
  badge: {
    horizontalPadding: 8,
    verticalPadding: 2,
    contentGap: 4,
  },
  chip: {
    minHeight: 44,
    horizontalPadding: 12,
    contentGap: 6,
  },
  header: {
    customContentHeight: 52,
  },
  appHeader: {
    /** The bar itself, below the status bar. Matches a UIKit navigation bar. */
    minHeight: 52,
    horizontalPadding: 8,
    /** Gap between the title block and whatever flanks it. */
    titleGap: 8,
    /** Gap between adjacent trailing actions. */
    actionGap: 4,
    /** Square target for the back chevron and each trailing action. */
    actionTarget: 44,
    /** Reserved width either side so a centred title never jitters. */
    sideSlot: 44,
    /** Visible monogram inside the square profile action target. */
    profileAvatar: 36,
    subtitleGap: 2,
  },
  bottomNav: {
    /** Navigation content above the device bottom safe-area inset. */
    contentHeight: 56,
    horizontalPadding: 8,
    verticalPadding: 4,
    itemGap: 2,
    icon: 20,
  },
  /**
   * The strip above the keyboard in a terminal. It is a composer, not a control
   * bar: its plates sit below the standard control height so the strip reads as
   * a thin edge to the keyboard rather than a second toolbar. Button's own
   * hit-slop carries each target back out to a comfortable one.
   */
  terminalAccessory: {
    controlHeight: 36,
    keyMinWidth: 40,
    keyHorizontalPadding: 10,
    horizontalPadding: 8,
    verticalPadding: 5,
    gap: 6,
  },

  /** A search field docked to the foot of a list screen. */
  searchDock: {
    horizontalPadding: 16,
    verticalPadding: 12,
    topGap: 8,
  },
  tab: {
    stripHeight: 56,
    visualHeight: 44,
    itemGap: 8,
    minWidth: 144,
    maxWidth: 200,
    closePlate: 20,
    closeGlyph: 14,
    actionTarget: 44,
    /** Radius of the flare that joins the active tab's foot to the panel. */
    connectionRadius: 6,
    /** How far the active tab overlaps the panel below it. */
    connectionOverlap: 6,
    horizontalPadding: 12,
    labelGap: 6,
  },
  type: {
    micro: { fontSize: 11, lineHeight: 16 },
    caption: { fontSize: 13, lineHeight: 18 },
    compactBody: { fontSize: 15, lineHeight: 22 },
    prose: { fontSize: 16, lineHeight: 24 },
    rowLabel: { fontSize: 16, lineHeight: 22 },
    componentLabel: { fontSize: 14, lineHeight: 20 },
    cardTitle: { fontSize: 16, lineHeight: 20 },
    prominentSectionTitle: { fontSize: 18, lineHeight: 24 },
    emptyStateTitle: { fontSize: 14, lineHeight: 20 },
    emptyStateBody: { fontSize: 14, lineHeight: 24 },
    navigationTitle: { fontSize: 17, lineHeight: 22 },
    displayTitle: { fontSize: 22, lineHeight: 28 },
    terminal: { fontSize: 13, lineHeight: 16 },
  },
} as const;

export type Sizing = typeof sizing;

/**
 * What the persistent bottom nav occupies at the foot of the window.
 *
 * The bar is portalled to window level, so nothing holds its footprint open in
 * the layout flow — screens reserve it with this. It lives here rather than with
 * the bar so a layout primitive can read it without importing the navigator and
 * everything the navigator imports.
 */
export function bottomNavHeight(bottomInset: number): number {
  return sizing.bottomNav.contentHeight + sizing.bottomNav.verticalPadding + bottomInset;
}
