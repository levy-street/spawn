import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";

import { formatLongtailDate } from "@/components/longtail/longtail-format";
import { SettingsBlock } from "@/components/settings/settings-block";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import type { AdminInviteOut, AdminWaitlistEntryOut } from "@/data/api/schemas/admin";
import {
  useAdminWaitlistQuery,
  useInviteFromWaitlistMutation,
  useRemoveFromWaitlistMutation,
} from "@/data/queries/admin";
import { duration, spacing } from "@/theme";

export type WaitlistBadgeLabel =
  | "waiting"
  | "invited"
  | "used"
  | "expired"
  | "revoked"
  | "has account";

/**
 * One word for where an entry stands. An account, however it came about,
 * outranks whatever happened to the invite: the person is in.
 */
export function waitlistBadge(entry: AdminWaitlistEntryOut): {
  label: WaitlistBadgeLabel;
  variant: BadgeVariant;
} {
  if (entry.has_account) return { label: "has account", variant: "success" };
  switch (entry.invite_state) {
    case null:
      return { label: "waiting", variant: "outline" };
    case "pending":
      return { label: "invited", variant: "info" };
    case "used":
      return { label: "used", variant: "success" };
    case "expired":
      return { label: "expired", variant: "warning" };
    case "revoked":
      return { label: "revoked", variant: "outline" };
  }
}

export interface WaitlistCardProps {
  entry: AdminWaitlistEntryOut;
  inviting: boolean;
  removing: boolean;
  onInvite: () => void;
  onRemove: () => void;
}

export function WaitlistCard({
  entry,
  inviting,
  removing,
  onInvite,
  onRemove,
}: WaitlistCardProps): React.JSX.Element {
  const badge = waitlistBadge(entry);
  return (
    <SettingsBlock testID={`admin-waitlist-${entry.id}`}>
      <View style={styles.cardHeader}>
        <View style={styles.cardCopy}>
          <Text numberOfLines={1} variant="label">
            {entry.email}
          </Text>
          <Text color="mutedForeground" variant="caption">
            Joined {formatLongtailDate(entry.created_at)}
            {entry.source ? ` from ${entry.source}` : ""}
          </Text>
        </View>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </View>
      {entry.invited_at ? (
        <Text color="mutedForeground" variant="caption">
          Invited {formatLongtailDate(entry.invited_at)}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button
          disabled={entry.has_account || removing}
          loading={inviting}
          onPress={onInvite}
          size="sm"
        >
          {entry.invite_state === null ? "Invite" : "Invite again"}
        </Button>
        <Button
          disabled={inviting}
          loading={removing}
          onPress={onRemove}
          size="sm"
          variant="outline"
        >
          Remove
        </Button>
      </View>
    </SettingsBlock>
  );
}

export function AdminWaitlistScreen(): React.JSX.Element {
  const toast = useToast();
  const confirm = useConfirm();
  const query = useAdminWaitlistQuery();
  const inviteMutation = useInviteFromWaitlistMutation();
  const removeMutation = useRemoveFromWaitlistMutation();
  const [fresh, setFresh] = useState<AdminInviteOut | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  const invite = (entry: AdminWaitlistEntryOut) => {
    inviteMutation.mutate(
      { entryId: entry.id },
      {
        onSuccess: (created) => {
          setFresh(created);
          setCopied(false);
          toast.success("Invite sent");
        },
        onError: (error) =>
          toast.error("Could not create invite", {
            detail: error instanceof Error ? error.message : "The request could not be completed.",
          }),
      },
    );
  };

  const remove = async (entry: AdminWaitlistEntryOut) => {
    const accepted = await confirm({
      title: `Remove ${entry.email} from the waitlist?`,
      description:
        "They will not be invited unless they join again. An invite already sent stays valid.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!accepted) return;
    removeMutation.mutate(entry.id, {
      onSuccess: () => toast.success("Removed from the waitlist"),
      onError: (error) =>
        toast.error("Could not remove the entry", {
          detail: error instanceof Error ? error.message : "The request could not be completed.",
        }),
    });
  };

  const copyFreshLink = async () => {
    if (!fresh?.url) return;
    try {
      await Clipboard.setStringAsync(fresh.url);
      setCopied(true);
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => {
        setCopied(false);
        copyTimer.current = null;
      }, duration.copyFeedback);
    } catch (error) {
      toast.error("Could not copy the invite link", {
        detail: error instanceof Error ? error.message : "Clipboard access failed.",
      });
    }
  };

  return (
    <SettingsScreen
      refreshControl={
        <RefreshControl onRefresh={() => void query.refetch()} refreshing={query.isRefetching} />
      }
      testID="admin-waitlist"
      title="Waitlist"
    >
      {fresh ? (
        <SettingsSection
          title={fresh.email ? `Invite ready, emailed to ${fresh.email}` : "Invite ready"}
        >
          <SettingsBlock testID="admin-waitlist-fresh">
            {fresh.url ? (
              <Text selectable variant="mono">
                {fresh.url}
              </Text>
            ) : (
              <Text color="warning" variant="caption">
                The server did not return a reusable invitation URL.
              </Text>
            )}
            <Text color="mutedForeground" variant="caption">
              Copy it now — the code is stored hashed, so this link cannot be shown again. Expires{" "}
              {formatLongtailDate(fresh.expires_at)}.
            </Text>
            <View style={styles.freshActions}>
              <Button
                disabled={!fresh.url}
                onPress={() => void copyFreshLink()}
                size="sm"
                variant="outline"
              >
                <Icon color="foreground" name={copied ? "Check" : "Copy"} size={spacing[4]} />
                {copied ? "Copied" : "Copy link"}
              </Button>
              <Button onPress={() => setFresh(null)} size="sm" variant="ghost">
                Dismiss
              </Button>
            </View>
          </SettingsBlock>
        </SettingsSection>
      ) : null}

      <SettingsSection
        description="People who asked for an invite while signup is closed."
        title="Waiting"
      >
        {query.isLoading ? (
          <View style={styles.loading}>
            <Spinner label="Loading the waitlist" size={spacing[6]} />
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
            title="Waitlist unavailable"
          />
        ) : (query.data?.length ?? 0) === 0 ? (
          <EmptyState
            description="Addresses left on the site and the closed signup form land here."
            title="No one is waiting."
          />
        ) : (
          query.data?.map((entry) => (
            <WaitlistCard
              entry={entry}
              inviting={inviteMutation.isPending && inviteMutation.variables?.entryId === entry.id}
              key={entry.id}
              onInvite={() => invite(entry)}
              onRemove={() => void remove(entry)}
              removing={removeMutation.isPending && removeMutation.variables === entry.id}
            />
          ))
        )}
      </SettingsSection>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
  cardCopy: {
    flex: 1,
    gap: spacing[1],
    minWidth: spacing[0],
  },
  cardHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[2],
  },
  freshActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
  loading: {
    alignItems: "center",
    padding: spacing[8],
  },
});
