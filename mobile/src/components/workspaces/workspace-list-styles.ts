import { StyleSheet } from "react-native";

import { borderWidth, chrome, radii, spacing, typeStyles } from "@/theme";

export const workspaceListStyles = StyleSheet.create({
  archivedButton: {
    alignSelf: "center",
    marginVertical: spacing[4],
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: spacing[12],
    paddingHorizontal: spacing[2.5],
  },
  heading: {
    ...typeStyles.uiSmMedium,
  },
  listContent: {
    paddingHorizontal: spacing[2.5],
  },
  rowSeparator: {
    height: spacing[1],
  },
  screen: {
    flex: 1,
  },
  search: {
    paddingBottom: spacing[2.5],
    paddingHorizontal: spacing[2.5],
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
    height: spacing[6],
    width: spacing[6],
  },
  skeletonRow: {
    alignItems: "center",
    borderRadius: radii.lg,
    flexDirection: "row",
    gap: spacing[2],
    height: chrome.touchTarget,
    paddingHorizontal: spacing[1.5],
  },
  skeletonTitle: {
    height: spacing[4],
    width: "72%",
  },
  skeletons: {
    gap: spacing[1],
    paddingHorizontal: spacing[2.5],
  },
  statusError: {
    alignItems: "center",
    borderBottomWidth: borderWidth.hairline,
    borderTopWidth: borderWidth.hairline,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing[2.5],
  },
});
