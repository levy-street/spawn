import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export interface WorkspaceListErrorProps {
  message: string;
  onRetry: () => void;
}

export function WorkspaceListError({ message, onRetry }: WorkspaceListErrorProps) {
  return (
    <EmptyState
      action={<Button onPress={onRetry}>Try again</Button>}
      description={message}
      icon="AlertCircle"
      title="Workspaces unavailable"
    />
  );
}
