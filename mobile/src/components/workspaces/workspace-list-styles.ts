import { StyleSheet } from "react-native";

import { borderWidth, fontSize, lineHeight, spacing } from "@/theme";

export const workspaceListStyles = StyleSheet.create({
  archivedButton: {
    alignSelf: "center",
    marginVertical: spacing[4],
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  heading: {
    fontSize: fontSize.displaySm,
    lineHeight: lineHeight.xl,
  },
  screen: {
    flex: 1,
  },
  search: {
    paddingBottom: spacing[2],
    paddingHorizontal: spacing[4],
  },
  skeletonCopy: {
    flex: 1,
    gap: spacing[2],
  },
  skeletonDetail: {
    height: spacing[3],
    width: "48%",
  },
  skeletonIcon: {
    height: spacing[11],
    width: spacing[11],
  },
  skeletonRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    minHeight: spacing[16] + spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  skeletonTitle: {
    height: spacing[4],
    width: "72%",
  },
  skeletons: {
    gap: spacing[1],
  },
  statusError: {
    alignItems: "center",
    borderBottomWidth: borderWidth.hairline,
    borderTopWidth: borderWidth.hairline,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing[4],
  },
});
