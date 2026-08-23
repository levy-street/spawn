import { StyleSheet } from "react-native";

import { sizing } from "@/theme/sizing";

/** Shared geometry for terminal and files rows inside a workspace tab. */
export const paneRowStyles = StyleSheet.create({
  action: {
    height: sizing.listRow.trailingTarget,
    position: "absolute",
    // Pulled in from the edge so the glyph is not crowding the screen border.
    right: sizing.listRow.trailingActionInset,
    top: (sizing.listRow.regular - sizing.listRow.trailingTarget) / 2,
    width: sizing.listRow.trailingTarget,
  },
  frame: {
    position: "relative",
  },
  status: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.space.peer,
    paddingRight: sizing.listRow.trailingTarget + sizing.listRow.trailingActionInset,
  },
  swipeContent: {
    // The action tray remains themed, while the resting row reveals its parent surface.
    backgroundColor: "transparent",
  },
});
