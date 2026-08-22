import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export interface WorkspaceListEmptyProps {
  query: string;
  onCreate: () => void;
}

export function WorkspaceListEmpty({ query, onCreate }: WorkspaceListEmptyProps) {
  return (
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
  );
}
