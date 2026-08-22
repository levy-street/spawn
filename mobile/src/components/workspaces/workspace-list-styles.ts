import { StyleSheet } from "react-native";

import { borderWidth, radii } from "@/theme";
import { sizing } from "@/theme/sizing";

export const workspaceListStyles = StyleSheet.create({
  archivedButton: {
    alignSelf: "center",
    marginVertical: sizing.space.block,
  },
  listContent: {
    paddingHorizontal: sizing.screen.gutter,
  },
  rowSeparator: {
    height: sizing.listRow.betweenRows,
  },
  screen: {
    flex: 1,
  },
  search: {
    paddingBottom: sizing.space.peer,
    paddingHorizontal: sizing.screen.gutter,
    paddingTop: sizing.space.peer,
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
    borderTopWidth: borderWidth.hairline,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: sizing.screen.gutter,
  },
});
