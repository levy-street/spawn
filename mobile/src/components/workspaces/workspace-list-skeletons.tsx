import { View } from "react-native";

import { Skeleton } from "@/components/ui/skeleton";
import { workspaceListStyles as styles } from "@/components/workspaces/workspace-list-styles";

export function WorkspaceListSkeletons() {
  const rows = ["first", "second", "third", "fourth", "fifth"];

  return (
    <View style={styles.skeletons} testID="workspace-list-loading">
      {rows.map((row) => (
        <View key={row} style={styles.skeletonRow}>
          <Skeleton style={styles.skeletonIcon} />
          <View style={styles.skeletonCopy}>
            <Skeleton style={styles.skeletonTitle} />
            <Skeleton style={styles.skeletonDetail} />
          </View>
        </View>
      ))}
    </View>
  );
}
