import { useState } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";

import { formatLongtailDate } from "@/components/longtail/longtail-format";
import { SettingsBlock } from "@/components/settings/settings-block";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import type { AdminEmailOut, AdminMailStatus } from "@/data/api/schemas/admin";
import {
  useAdminEmailsQuery,
  useAdminMailQuery,
  useSendAdminTestEmailMutation,
} from "@/data/queries/admin";
import { borderWidth, spacing, useTheme } from "@/theme";

export function emailBadgeVariant(status: AdminEmailOut["status"]): BadgeVariant {
  switch (status) {
    case "sent":
      return "success";
    case "failed":
      return "destructive";
    case "not_delivered":
      return "warning";
  }
}

interface MailStatusCardProps {
  mail: AdminMailStatus;
  sending: boolean;
  onSendTest: () => void;
}

function MailStatusCard({ mail, sending, onSendTest }: MailStatusCardProps): React.JSX.Element {
  return (
    <SettingsBlock>
      <View style={styles.statusCard}>
        <View style={styles.rowHeader}>
          <Text variant="label">Delivery</Text>
          <Badge variant={mail.delivering ? "success" : "warning"}>
            {mail.delivering ? "delivering" : "not delivering"}
          </Badge>
        </View>
        {mail.delivering ? (
          <Text color="mutedForeground" variant="caption">
            Delivering via {mail.smtp_host ?? mail.backend} as {mail.from_address}
          </Text>
        ) : (
          <Text color="mutedForeground" variant="caption">
            Not delivering — backend is {mail.backend}. Password resets and invitations are recorded
            but never sent. Set SPAWN_SMTP_HOST to turn delivery on.
          </Text>
        )}
        <Button loading={sending} onPress={onSendTest} size="sm" variant="outline">
          {sending ? "Sending…" : "Send test email"}
        </Button>
      </View>
    </SettingsBlock>
  );
}

export interface AdminEmailRecordProps {
  email: AdminEmailOut;
  expanded: boolean;
  onToggle: () => void;
}

export function AdminEmailRecord({
  email,
  expanded,
  onToggle,
}: AdminEmailRecordProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <SettingsBlock padded={false} testID={`admin-email-${email.id}`}>
      <Pressable
        accessibilityLabel={`${expanded ? "Collapse" : "Expand"} email ${email.subject}`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={({ pressed }) => [
          styles.emailHeader,
          { backgroundColor: pressed ? theme.colors.accent : "transparent" },
        ]}
      >
        <View style={styles.emailCopy}>
          <Text numberOfLines={1} variant="label">
            {email.subject}
          </Text>
          <Text color="mutedForeground" numberOfLines={1} variant="caption">
            {formatLongtailDate(email.created_at)} · {email.to_email} · {email.kind}
          </Text>
        </View>
        <Badge variant={emailBadgeVariant(email.status)}>
          {email.status === "not_delivered" ? "not delivered" : email.status}
        </Badge>
        <Icon
          color="mutedForeground"
          name={expanded ? "ChevronUp" : "ChevronDown"}
          size={spacing[4]}
        />
      </Pressable>
      {expanded ? (
        <View style={[styles.emailDetail, { borderTopColor: theme.colors.border }]}>
          {email.error ? (
            <Text color="destructive" variant="caption">
              {email.error}
            </Text>
          ) : null}
          <Text selectable variant="mono">
            {email.body_redacted || "(body not recorded)"}
          </Text>
        </View>
      ) : null}
    </SettingsBlock>
  );
}

export function AdminEmailScreen(): React.JSX.Element {
  const toast = useToast();
  const mailQuery = useAdminMailQuery();
  const emailsQuery = useAdminEmailsQuery();
  const sendMutation = useSendAdminTestEmailMutation();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sendTest = () => {
    sendMutation.mutate(
      { to: null },
      {
        onSuccess: (email) => {
          if (email.status === "sent") {
            toast.success(`Sent to ${email.to_email}.`);
          } else {
            toast.error(`Not delivered: ${email.error ?? "unknown reason"}`);
          }
        },
        onError: (error) =>
          toast.error("Could not send a test email", {
            detail: error instanceof Error ? error.message : "The request could not be completed.",
          }),
      },
    );
  };

  const refresh = async () => {
    await Promise.all([mailQuery.refetch(), emailsQuery.refetch()]);
  };

  return (
    <SettingsScreen
      description="Every attempt is logged. Credentials are stripped from the body."
      refreshControl={
        <RefreshControl
          onRefresh={() => void refresh()}
          refreshing={mailQuery.isRefetching || emailsQuery.isRefetching}
        />
      }
      testID="admin-email"
      title="Email"
    >
      <SettingsSection title="Mail configuration">
        {mailQuery.isLoading ? (
          <View style={styles.loadingRow}>
            <Spinner label="Checking mail configuration" />
            <Text color="mutedForeground" variant="caption">
              Checking mail configuration…
            </Text>
          </View>
        ) : mailQuery.error || !mailQuery.data ? (
          <EmptyState
            action={
              <Button onPress={() => void mailQuery.refetch()} variant="outline">
                Try again
              </Button>
            }
            description={
              mailQuery.error instanceof Error
                ? mailQuery.error.message
                : "Mail configuration was not returned."
            }
            icon="AlertCircle"
            title="Mail status unavailable"
          />
        ) : (
          <MailStatusCard
            mail={mailQuery.data}
            onSendTest={sendTest}
            sending={sendMutation.isPending}
          />
        )}
      </SettingsSection>

      <SettingsSection title="Email log">
        {emailsQuery.isLoading ? (
          <View style={styles.loading}>
            <Spinner label="Loading email records" size={spacing[6]} />
          </View>
        ) : emailsQuery.error ? (
          <EmptyState
            action={
              <Button onPress={() => void emailsQuery.refetch()} variant="outline">
                Try again
              </Button>
            }
            description={
              emailsQuery.error instanceof Error ? emailsQuery.error.message : "The request failed."
            }
            icon="AlertCircle"
            title="Email records unavailable"
          />
        ) : (emailsQuery.data?.length ?? 0) === 0 ? (
          <EmptyState
            description="Attempted messages will appear here."
            title="No email sent yet"
          />
        ) : (
          <View style={styles.list}>
            {emailsQuery.data?.map((email) => (
              <AdminEmailRecord
                email={email}
                expanded={expandedId === email.id}
                key={email.id}
                onToggle={() =>
                  setExpandedId((current) => (current === email.id ? null : email.id))
                }
              />
            ))}
          </View>
        )}
      </SettingsSection>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  emailCopy: {
    flex: 1,
    gap: spacing[1],
    minWidth: spacing[0],
  },
  emailDetail: {
    borderTopWidth: borderWidth.hairline,
    gap: spacing[3],
    padding: spacing[3],
  },
  emailHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    minHeight: spacing[14],
    padding: spacing[3],
  },
  list: {
    gap: spacing[2],
  },
  loading: {
    alignItems: "center",
    padding: spacing[8],
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    padding: spacing[4],
  },
  rowHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  statusCard: {
    alignItems: "flex-start",
    gap: spacing[3],
  },
});
