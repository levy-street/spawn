import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { sizing } from "@/theme/sizing";

export interface WorkspaceListEmptyProps {
  query: string;
  onCreate: () => void;
}

export function WorkspaceListEmpty({ query, onCreate }: WorkspaceListEmptyProps) {
  return (
    // The plate is a card, not a page: it needs the screen gutter around it and
    // air above it, or it reads as the list itself having gone blank.
    <View style={styles.frame}>
      <EmptyState
        action={
          query ? undefined : (
            <Button onPress={onCreate} variant="outline">
              New workspace
            </Button>
          )
        }
        description={
          query
            ? "Try a different name."
            : "Create a workspace for the shells and coding agents you use together."
        }
        icon={query ? "Search" : "Shapes"}
        title={query ? "No workspaces match" : "No workspaces yet"}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    paddingHorizontal: sizing.screen.gutter,
    paddingTop: sizing.space.section,
  },
});
