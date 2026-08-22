import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";

import { formatLongtailDate } from "@/components/longtail/longtail-format";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import type { AdminInviteCreate, AdminInviteOut } from "@/data/api/schemas/admin";
import { AdminInviteCreateSchema } from "@/data/api/schemas/admin";
import {
  useAdminInvitesQuery,
  useCreateAdminInviteMutation,
  useRevokeAdminInviteMutation,
} from "@/data/queries/admin";
import { duration, spacing } from "@/theme";

export type AdminInviteInputResult =
  | { ok: true; value: AdminInviteCreate }
  | { ok: false; field: "email" | "ttl"; message: string };

export function parseAdminInviteInput(email: string, ttlHours: string): AdminInviteInputResult {
  const hours = Number(ttlHours.trim());
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
    return {
      ok: false,
      field: "ttl",
      message: "Expiry must be a whole number from 1 to 720.",
    };
  }
  const normalizedEmail = email.trim();
  const value = {
    email: normalizedEmail.length === 0 ? null : normalizedEmail,
    ttl_hours: hours,
  };
  const parsed = AdminInviteCreateSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, field: "email", message: "Enter a valid email address." };
  }
  return { ok: true, value: parsed.data };
}

export function inviteBadgeVariant(state: AdminInviteOut["state"]): BadgeVariant {
  switch (state) {
    case "pending":
      return "info";
    case "used":
      return "success";
    case "expired":
      return "warning";
    case "revoked":
      return "outline";
  }
}

interface InviteCardProps {
  invite: AdminInviteOut;
  revoking: boolean;
  onRevoke: () => void;
}

function InviteCard({ invite, revoking, onRevoke }: InviteCardProps): React.JSX.Element {
  return (
    <Card style={styles.inviteCard} variant="flat">
      <View style={styles.cardHeader}>
        <View style={styles.cardCopy}>
          <Text numberOfLines={1} variant="label">
            {invite.email ?? "anyone with the link"}
          </Text>
          <Text color="mutedForeground" variant="caption">
            Created {formatLongtailDate(invite.created_at)}
          </Text>
        </View>
        <Badge variant={inviteBadgeVariant(invite.state)}>{invite.state}</Badge>
      </View>
      <Text color="mutedForeground" variant="caption">
        Expires {formatLongtailDate(invite.expires_at)}
      </Text>
      {invite.state === "pending" ? (
        <Button loading={revoking} onPress={onRevoke} size="sm" variant="outline">
          Revoke
        </Button>
      ) : null}
    </Card>
  );
}

export function AdminInvitesScreen(): React.JSX.Element {
  const toast = useToast();
  const query = useAdminInvitesQuery();
  const createMutation = useCreateAdminInviteMutation();
  const revokeMutation = useRevokeAdminInviteMutation();
  const [email, setEmail] = useState("");
  const [ttlHours, setTtlHours] = useState("72");
  const [inputError, setInputError] = useState<AdminInviteInputResult | null>(null);
  const [fresh, setFresh] = useState<AdminInviteOut | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  const submit = () => {
    const parsed = parseAdminInviteInput(email, ttlHours);
    if (!parsed.ok) {
      setInputError(parsed);
      return;
    }
    setInputError(null);
    createMutation.mutate(parsed.value, {
      onSuccess: (invite) => {
        setFresh(invite);
        setEmail("");
        toast.success("Invite created");
      },
      onError: (error) =>
        toast.error("Could not create invite", {
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

  const revoke = (invite: AdminInviteOut) => {
    revokeMutation.mutate(invite.id, {
      onSuccess: () => toast.success("Invite revoked"),
      onError: (error) =>
        toast.error("Could not revoke invite", {
          detail: error instanceof Error ? error.message : "The request could not be completed.",
        }),
    });
  };

  return (
    <SettingsScreen
      description="Signup is closed: an invite admits exactly one account, once, before it expires."
      refreshControl={
        <RefreshControl onRefresh={() => void query.refetch()} refreshing={query.isRefetching} />
      }
      testID="admin-invites"
      title="Invites"
    >
      <SettingsSection title="Create invite">
        <Card style={styles.form} variant="flat">
          <Field
            error={
              inputError?.ok === false && inputError.field === "email" ? inputError.message : null
            }
            hint="Leave blank for anyone with the link."
            label="Email (optional)"
          >
            <Input
              editable={!createMutation.isPending}
              onChangeText={setEmail}
              placeholder="send it for me"
              purpose="email"
              value={email}
            />
          </Field>
          <Field
            error={
              inputError?.ok === false && inputError.field === "ttl" ? inputError.message : null
            }
            label="Expires in (hours)"
          >
            <Input
              editable={!createMutation.isPending}
              keyboardType="number-pad"
              maxLength={3}
              onChangeText={setTtlHours}
              purpose="plain"
              value={ttlHours}
            />
          </Field>
          <Button loading={createMutation.isPending} onPress={submit}>
            {createMutation.isPending ? "Creating…" : "Create invite"}
          </Button>
        </Card>
      </SettingsSection>

      {fresh ? (
        <SettingsSection
          title={fresh.email ? `Invite ready — emailed to ${fresh.email}` : "Invite ready"}
        >
          <Card style={styles.freshCard} variant="flat">
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
          </Card>
        </SettingsSection>
      ) : null}

      <SettingsSection title="Existing invites">
        {query.isLoading ? (
          <View style={styles.loading}>
            <Spinner label="Loading invitations" size={spacing[6]} />
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
            title="Invites unavailable"
          />
        ) : (query.data?.length ?? 0) === 0 ? (
          <EmptyState
            description="Create one above when someone needs access."
            title="No invites yet"
          />
        ) : (
          query.data?.map((invite) => (
            <InviteCard
              invite={invite}
              key={invite.id}
              onRevoke={() => revoke(invite)}
              revoking={revokeMutation.isPending && revokeMutation.variables === invite.id}
            />
          ))
        )}
      </SettingsSection>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
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
  form: {
    gap: spacing[3],
  },
  freshActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
  freshCard: {
    gap: spacing[3],
  },
  inviteCard: {
    gap: spacing[2],
  },
  loading: {
    alignItems: "center",
    padding: spacing[8],
  },
});
