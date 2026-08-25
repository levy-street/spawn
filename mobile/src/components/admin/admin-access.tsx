import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import type { UserOut } from "@/data/api/schemas/auth";
import { spacing, useTheme } from "@/theme";

export type AdminAccessState = "loading" | "error" | "denied" | "allowed";

export interface ResolveAdminAccessInput {
  error: unknown;
  loading: boolean;
  user: Pick<UserOut, "is_admin"> | null | undefined;
}

export function resolveAdminAccess({
  error,
  loading,
  user,
}: ResolveAdminAccessInput): AdminAccessState {
  if (loading) return "loading";
  if (error !== null && error !== undefined) return "error";
  return user?.is_admin === true ? "allowed" : "denied";
}

export interface AdminAccessBoundaryProps {
  children: ReactNode;
  errorMessage?: string | undefined;
  onBack: () => void;
  onRetry: () => void;
  state: AdminAccessState;
}

export function AdminAccessBoundary({
  children,
  errorMessage,
  onBack,
  onRetry,
  state,
}: AdminAccessBoundaryProps): React.JSX.Element {
  const theme = useTheme();

  if (state === "allowed") return <>{children}</>;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.colors.background }]}>
      {state === "loading" ? (
        <View style={styles.center}>
          <Spinner label="Checking administrator access" size={spacing[6]} />
        </View>
      ) : state === "error" ? (
        <EmptyState
          action={
            <Button onPress={onRetry} variant="outline">
              Try again
            </Button>
          }
          description={errorMessage ?? "Administrator access could not be checked."}
          icon="ShieldAlert"
          title="Admin unavailable"
        />
      ) : (
        <EmptyState
          action={<Button onPress={onBack}>Back to SPAWN D</Button>}
          description="This account does not administer this deployment."
          icon="ShieldOff"
          testID="admin-access-denied"
          title="Nothing here"
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  screen: {
    flex: 1,
  },
});
