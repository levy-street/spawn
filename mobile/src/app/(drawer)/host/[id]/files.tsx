import { Stack, useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";
import { FileExplorer } from "@/components/files/file-explorer";
import { Screen } from "@/components/layout/screen";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { useFileHost } from "@/data/queries/files";
import { spacing, useTheme } from "@/theme";

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default function HostFilesRoute() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ id?: string | string[]; path?: string | string[] }>();
  const hostId = param(params.id);
  const initialPath = param(params.path) || undefined;
  const host = useFileHost(hostId);
  if (host.isLoading) {
    return (
      <Screen padded={false}>
        <View style={[styles.center, { backgroundColor: theme.colors.background }]}>
          <Spinner label="Loading host" size={spacing[6]} />
        </View>
      </Screen>
    );
  }
  if (host.isError || !host.data) {
    return (
      <Screen padded={false}>
        <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
          <EmptyState
            action={
              <Button onPress={() => void host.refetch()} variant="outline">
                Try again
              </Button>
            }
            description="This host could not be loaded."
            icon="Unplug"
            title="Host unavailable"
          />
        </View>
      </Screen>
    );
  }
  if (host.data.status !== "online") {
    return (
      <Screen padded={false}>
        <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
          <EmptyState
            description="File browsing needs a live, direct connection to this host."
            icon="Unplug"
            title={`${host.data.name} is offline`}
          />
        </View>
      </Screen>
    );
  }
  if (!host.data.host_public_key) {
    return (
      <Screen padded={false}>
        <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
          <EmptyState
            description="Reconnect this host to establish its trusted identity before browsing files."
            icon="ShieldAlert"
            title="Host identity unavailable"
          />
        </View>
      </Screen>
    );
  }
  return (
    <Screen padded={false}>
      <Stack.Screen options={{ title: host.data.name }} />
      <FileExplorer
        hostId={host.data.id}
        hostIdentityPublicKey={host.data.host_public_key}
        hostName={host.data.name}
        {...(initialPath === undefined ? {} : { initialPath })}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", flex: 1, justifyContent: "center" },
  root: { flex: 1 },
});
