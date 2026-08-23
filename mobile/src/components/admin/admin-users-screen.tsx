import { RefreshControl, StyleSheet, View } from "react-native";

import { formatLongtailDate } from "@/components/longtail/longtail-format";
import { SettingsBlock } from "@/components/settings/settings-block";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import type { AdminUserOut } from "@/data/api/schemas/admin";
import { useAdminUsersQuery } from "@/data/queries/admin";
import { borderWidth, spacing, useTheme } from "@/theme";

interface CountCellProps {
  label: string;
  value: number;
}

function CountCell({ label, value }: CountCellProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.countCell, { borderColor: theme.colors.border }]}>
      <Text variant="label">{value}</Text>
      <Text color="mutedForeground" variant="micro">
        {label}
      </Text>
    </View>
  );
}

interface AdminUserCardProps {
  user: AdminUserOut;
}

function AdminUserCard({ user }: AdminUserCardProps): React.JSX.Element {
  return (
    <SettingsBlock testID={`admin-user-${user.id}`}>
      <View style={styles.header}>
        <View style={styles.identity}>
          <Text numberOfLines={1} variant="label">
            {user.email}
          </Text>
          <Text color="mutedForeground" selectable variant="mono">
            {user.id}
          </Text>
        </View>
        {user.is_admin ? <Badge variant="outline">admin</Badge> : null}
      </View>
      <View style={styles.timestamps}>
        <Text color="mutedForeground" variant="caption">
          Joined {formatLongtailDate(user.created_at)}
        </Text>
        {user.email_verified_at ? (
          <Text color="mutedForeground" variant="caption">
            Verified {formatLongtailDate(user.email_verified_at)}
          </Text>
        ) : (
          <Badge variant="warning">unverified</Badge>
        )}
      </View>
      <View style={styles.counts}>
        <CountCell label="Hosts" value={user.host_count} />
        <CountCell label="Sessions" value={user.session_count} />
        <CountCell label="Devices" value={user.browser_device_count} />
      </View>
    </SettingsBlock>
  );
}

export interface AdminUsersContentProps {
  users: readonly AdminUserOut[];
}

export function AdminUsersContent({ users }: AdminUsersContentProps): React.JSX.Element {
  if (users.length === 0) {
    return (
      <EmptyState
        description="No accounts have joined this deployment."
        icon="UserRound"
        title="No users"
      />
    );
  }
  return (
    <View style={styles.list}>
      {users.map((user) => (
        <AdminUserCard key={user.id} user={user} />
      ))}
    </View>
  );
}

export function AdminUsersScreen(): React.JSX.Element {
  const query = useAdminUsersQuery();
  const total = query.data?.length ?? 0;

  return (
    <SettingsScreen
      description={`Every account on this deployment. ${total} total.`}
      refreshControl={
        <RefreshControl onRefresh={() => void query.refetch()} refreshing={query.isRefetching} />
      }
      testID="admin-users"
      title="Users"
    >
      <SettingsSection>
        {query.isLoading ? (
          <View style={styles.loading}>
            <Spinner label="Loading users" size={spacing[6]} />
          </View>
        ) : query.error ? (
          <EmptyState
            action={
              <Button onPress={() => void query.refetch()} variant="outline">
                Try again
              </Button>
            }
            description={query.error instanceof Error ? query.error.message : "The request failed."}
            icon="AlertCircle"
            title="Users unavailable"
          />
        ) : (
          <AdminUsersContent users={query.data ?? []} />
        )}
      </SettingsSection>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  countCell: {
    borderRightWidth: borderWidth.hairline,
    flex: 1,
    gap: spacing[1],
    paddingHorizontal: spacing[2],
  },
  counts: {
    flexDirection: "row",
    marginHorizontal: -spacing[2],
  },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[2],
  },
  identity: {
    flex: 1,
    gap: spacing[1],
    minWidth: spacing[0],
  },
  list: {
    gap: spacing[2],
  },
  loading: {
    alignItems: "center",
    padding: spacing[8],
  },
  timestamps: {
    alignItems: "flex-start",
    gap: spacing[1],
  },
});
