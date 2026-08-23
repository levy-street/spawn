import { StyleSheet } from "react-native";

import { borderWidth, radii } from "@/theme";
import { sizing } from "@/theme/sizing";

export const workspaceListStyles = StyleSheet.create({
  // A handful of workspaces leave the rest of the screen empty, and scrollable
  // content that stops under the last row takes the pull-to-refresh gesture
  // with it. Growing the content to the full height keeps every point between
  // the search field and the archived footer on the refresh surface.
  listContent: {
    flexGrow: 1,
  },
  screen: {
    flex: 1,
  },
  searchControls: {
    paddingHorizontal: sizing.screen.gutter,
    paddingVertical: sizing.space.cluster,
  },
  skeletonCopy: {
    flex: 1,
    gap: sizing.space.peer,
  },
  skeletonDetail: {
    height: sizing.space.cluster,
    width: "48%",
  },
  skeletonIcon: {
    height: sizing.listRow.leading.workspace,
    width: sizing.listRow.leading.workspace,
  },
  skeletonRow: {
    alignItems: "center",
    borderRadius: radii.lg,
    flexDirection: "row",
    gap: sizing.listRow.contentGap,
    minHeight: sizing.listRow.tall,
    paddingHorizontal: sizing.listRow.workspaceHorizontalPadding,
    paddingVertical: sizing.listRow.workspaceVerticalPadding,
  },
  skeletonTitle: {
    height: sizing.space.block,
    width: "72%",
  },
  skeletons: {
    gap: sizing.listRow.betweenRows,
    paddingHorizontal: sizing.screen.gutter,
    paddingTop: sizing.space.peer,
  },
  statusError: {
    alignItems: "center",
    borderBottomWidth: borderWidth.hairline,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: sizing.screen.gutter,
  },
});
