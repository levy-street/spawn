import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { FileBrowserBody, type FolderNavigation } from "@/components/files/file-browser-body";
import { HOST_IDENTITY_BLOCKED_REASON } from "@/components/hosts/host-trust-copy";
import { EmptyState } from "@/components/ui/empty-state";
import type { IconName } from "@/components/ui/icon";
import type { HostOut } from "@/data/api/schemas/hosts";
import { spacing, useTheme } from "@/theme";

export interface FilesTabProps {
  host: HostOut;
  identityConflict: boolean;
  refreshing: boolean;
  onRefresh(): void;
  /** Opens the host's file browser at `path`, as a screen of its own. */
  onOpenFiles(path?: string): void;
}

/** Why the host's files cannot be browsed from here, in the words the tab shows. */
export interface FilesBlocked {
  title: string;
  description: string;
  icon: IconName;
}

/**
 * Why the file browser cannot open right now, or null when it can. A changed
 * identity and an offline host are said as the browser says them; a host this
 * device holds no key for, as the file browser itself does.
 */
export function filesBlocked(
  host: Pick<HostOut, "name" | "status" | "host_public_key">,
  identityConflict: boolean,
): FilesBlocked | null {
  if (identityConflict) {
    return {
      title: "Files are blocked",
      description: HOST_IDENTITY_BLOCKED_REASON,
      icon: "ShieldAlert",
    };
  }
  if (host.status !== "online") {
    return {
      title: `${host.name} is offline`,
      description: "File browsing needs a live, direct connection to this host.",
      icon: "Unplug",
    };
  }
  if (host.host_public_key === null) {
    return {
      title: "Host identity unavailable",
      description: "Reconnect this host to establish its trusted identity before browsing files.",
      icon: "ShieldAlert",
    };
  }
  return null;
}

/**
 * The host's files: the file browser itself, at home, embedded in the page.
 * A folder opened from it is pushed as /host/[id]/files, one screen per
 * folder as everywhere else, so the edge swipe and Android's back come back
 * here. The tab is drawn only while it is in front, and the body gives its
 * host channel back while another screen covers the page. When the host's
 * files cannot be browsed, the tab says why instead and opens nothing.
 */
export function FilesTab({
  host,
  identityConflict,
  refreshing,
  onRefresh,
  onOpenFiles,
}: FilesTabProps): React.JSX.Element {
  const theme = useTheme();
  const blocked = filesBlocked(host, identityConflict);
  const hostKey = host.host_public_key;

  if (blocked || hostKey === null) {
    return (
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            onRefresh={onRefresh}
            refreshing={refreshing}
            tintColor={theme.colors.mutedForeground}
          />
        }
        testID="host-files-tab"
      >
        {blocked ? (
          <EmptyState
            description={blocked.description}
            icon={blocked.icon}
            testID="host-files-blocked"
            title={blocked.title}
          />
        ) : null}
      </ScrollView>
    );
  }

  return (
    <View style={styles.browser} testID="host-files-tab">
      <FileBrowserBody
        hostId={host.id}
        hostIdentityPublicKey={hostKey}
        hostName={host.name}
        hostOS={host.os}
        onOpenFolder={({ path }: FolderNavigation) => onOpenFiles(path)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  browser: {
    flex: 1,
  },
  content: {
    gap: spacing[8],
    padding: spacing[4],
    paddingBottom: spacing[8],
  },
});
