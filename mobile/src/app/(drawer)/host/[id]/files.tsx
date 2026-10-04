import { type Href, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { FolderNavigation } from "@/components/files/file-browser-body";
import { FileExplorer } from "@/components/files/file-explorer";
import type { OpenedWindow } from "@/components/files/files-open-here";
import { screensBackToFolder } from "@/components/files/folder-stack";
import { normalizeCwdForHost, pathEquals, pathFlavorForHostOS } from "@/components/files/paths";
import { HostIdentityConflict } from "@/components/hosts/host-identity-conflict";
import {
  HOST_IDENTITY_BLOCKED_REASON,
  REMOVE_HOST_DESCRIPTION,
} from "@/components/hosts/host-trust-copy";
import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import type { HostOut } from "@/data/api/schemas/hosts";
import { useFileHost, useHostHome } from "@/data/queries/files";
import { useHostIdentityConflictQuery, useRemoveHostMutation } from "@/data/queries/hosts";
import { spacing, useTheme } from "@/theme";

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/**
 * One folder of a host's files. Opening a folder pushes another of these, so
 * the edge swipe and Android's back go to the folder before; a breadcrumb
 * goes back to its folder when it is the one underneath, and pushes it when
 * the explorer was opened deeper than that (from a terminal's folder, say).
 */
export default function HostFilesRoute() {
  const theme = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const params = useLocalSearchParams<{ id?: string | string[]; path?: string | string[] }>();
  const hostId = param(params.id);
  const initialPath = param(params.path) || undefined;
  const host = useFileHost(hostId);
  // A host that answers with an identity this device did not approve is shut,
  // as on its own page and in the browser: a link straight here is no way round.
  const identityConflict = useHostIdentityConflictQuery(host.data).data === true;
  const home = useHostHome(hostId, null, false);
  const hostOS = host.data?.os ?? null;
  const homeDir = home.data?.home_dir ?? null;

  const openFolder = useCallback(
    ({ path, ancestor }: FolderNavigation) => {
      if (ancestor && homeDir) {
        const flavor = pathFlavorForHostOS(hostOS);
        const target = normalizeCwdForHost(path, homeDir, flavor);
        const state = navigation.getState();
        const back = state
          ? screensBackToFolder(state.routes, state.index, hostId, (candidate) =>
              pathEquals(normalizeCwdForHost(candidate, homeDir, flavor), target, flavor),
            )
          : 0;
        if (back > 0) {
          router.dismiss(back);
          return;
        }
      }
      router.push({ pathname: "/host/[id]/files", params: { id: hostId, path } });
    },
    [homeDir, hostId, hostOS, navigation, router],
  );

  // A window opened from a folder shows in its workspace, as one opened from the host's page does.
  const openWindow = useCallback(
    ({ workspaceId, sessionId }: OpenedWindow) => {
      router.push({ pathname: "/workspace/[id]", params: { id: workspaceId } });
      router.push(`/terminal/${sessionId}` as Href);
    },
    [router],
  );

  const header = <AppHeader onBack={router.back} title="Files" />;
  if (host.isLoading) {
    return (
      <Screen header={header} padded={false}>
        <View style={[styles.center, { backgroundColor: theme.colors.background }]}>
          <Spinner label="Loading host" size={spacing[6]} />
        </View>
      </Screen>
    );
  }
  if (host.isError || !host.data) {
    return (
      <Screen header={header} padded={false}>
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
  if (identityConflict) {
    return (
      <Screen header={header} padded={false}>
        <FilesBlockedByIdentity host={host.data} />
      </Screen>
    );
  }
  if (host.data.status !== "online") {
    return (
      <Screen header={header} padded={false}>
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
      <Screen header={header} padded={false}>
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
    <FileExplorer
      hostId={host.data.id}
      hostIdentityPublicKey={host.data.host_public_key}
      hostName={host.data.name}
      hostOS={host.data.os}
      onBack={router.back}
      onOpenFolder={openFolder}
      onWindowOpened={openWindow}
      {...(initialPath === undefined ? {} : { initialPath })}
    />
  );
}

/**
 * The host's identity changed: the panel with its one way out, removal, and
 * why the files stay shut until then. Nothing here opens a channel.
 */
function FilesBlockedByIdentity({ host }: { host: HostOut }) {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const remove = useRemoveHostMutation();
  const [confirming, setConfirming] = useState(false);
  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={styles.panel}>
        <HostIdentityConflict onRemove={() => setConfirming(true)} removing={remove.isPending} />
      </View>
      <EmptyState
        description={HOST_IDENTITY_BLOCKED_REASON}
        icon="ShieldAlert"
        title="Files are blocked"
      />
      <Confirm
        confirmLabel={remove.error ? "Retry deletion" : "Remove host"}
        description={REMOVE_HOST_DESCRIPTION}
        destructive
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          // The sheet closes on the answer; the panel's button waits while it runs.
          setConfirming(false);
          if (remove.isPending) return;
          remove.mutate(host, {
            onError: (error) => toast.error("Could not remove host", { detail: error.message }),
            onSuccess: () => {
              toast.success("Host removed");
              router.replace("/hosts");
            },
          });
        }}
        title={`Remove ${host.name}?`}
        visible={confirming}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", flex: 1, justifyContent: "center" },
  panel: { padding: spacing[4] },
  root: { flex: 1 },
});
