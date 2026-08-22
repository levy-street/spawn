import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { clearNotificationPreferences } from "@/components/settings/notification-preferences";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import { logOut, requestEmailVerification } from "@/data/api/endpoints/auth";
import { useDeleteAccountMutation, useMeSettingsQuery } from "@/data/queries/settings";
import { useConnectionStore } from "@/data/stores/connection";
import { deviceIdentity, setDeviceIdentityAccount } from "@/lib/crypto/identity";
import { borderWidth, spacing, THEME_STORAGE_KEY, useTheme } from "@/theme";

const ONBOARDING_HOST_SKIP_STORAGE_KEY = "spawn.onboarding.skippedHost";

export function AccountPanel(): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const theme = useTheme();
  const toast = useToast();
  const me = useMeSettingsQuery();
  const remove = useDeleteAccountMutation();
  const [confirming, setConfirming] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resendNote, setResendNote] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const user = me.data?.user;
  const emailMatches =
    user !== undefined && confirmEmail.trim().toLowerCase() === user.email.toLowerCase();

  const signOut = async () => {
    await logOut().catch(() => undefined);
    useConnectionStore.getState().reset();
    queryClient.clear();
    router.replace("/login");
  };

  const deletePermanently = async () => {
    if (!user || !emailMatches) return;
    await remove.mutateAsync({
      confirm_email: confirmEmail.trim(),
      ...(password.length > 0 ? { password } : {}),
    });
    setDeviceIdentityAccount(user.id);
    try {
      await Promise.all([
        deviceIdentity.reset(),
        clearNotificationPreferences(),
        AsyncStorage.removeItem(THEME_STORAGE_KEY),
        AsyncStorage.removeItem(ONBOARDING_HOST_SKIP_STORAGE_KEY),
      ]);
    } catch (cause) {
      toast.error("Account deleted, but local device data could not be cleared.", {
        detail: cause instanceof Error ? cause.message : "Local cleanup failed.",
      });
    }
    useConnectionStore.getState().reset();
    queryClient.clear();
    router.replace("/login");
  };

  if (me.isPending) {
    return (
      <SettingsScreen title="Account">
        <Skeleton style={styles.skeleton} />
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen testID="account-panel" title="Account">
      <View style={styles.accountHeader}>
        <Text color="mutedForeground" variant="body">
          Signed in as {user?.email ?? "—"}
        </Text>
      </View>

      {user?.email_verified_at === null ? (
        <Card
          style={{ borderColor: theme.colors.warning }}
          testID="verify-email-callout"
          variant="flat"
        >
          <View style={styles.callout}>
            <Text variant="label">Confirm your email address</Text>
            <Text color="mutedForeground" variant="body">
              We sent a link to {user.email}. Verifying keeps account recovery working — a password
              reset can only reach an address you control.
            </Text>
            {resendNote ? (
              <Text accessibilityLiveRegion="polite" variant="body">
                {resendNote}
              </Text>
            ) : null}
            <Button
              loading={resending}
              onPress={() => {
                setResending(true);
                void requestEmailVerification()
                  .then(() => setResendNote("Sent — check your inbox."))
                  .catch(() => setResendNote("Could not send right now."))
                  .finally(() => setResending(false));
              }}
              size="sm"
              variant="secondary"
            >
              {resending ? "Sending…" : "Resend verification email"}
            </Button>
          </View>
        </Card>
      ) : null}

      <Button onPress={() => void signOut()} variant="secondary">
        Log out
      </Button>

      <Card
        style={{ borderColor: theme.colors.destructive }}
        testID="delete-account-section"
        variant="flat"
      >
        <View style={styles.danger}>
          <View style={styles.callout}>
            <Text variant="label">Delete account</Text>
            <Text color="mutedForeground" variant="body">
              Permanently deletes this account: every host pairing, session, workspace, agent,
              skill, device identity, and saved trust. Daemons on your machines keep running but
              lose this server. This cannot be undone.
            </Text>
          </View>
          {!confirming ? (
            <Button onPress={() => setConfirming(true)} variant="secondary">
              Delete account…
            </Button>
          ) : null}
          <Collapse open={confirming} testID="delete-account-form">
            <View style={styles.form}>
              <Field label="Type your email to confirm">
                <Input
                  autoComplete="off"
                  autoFocus
                  editable={!remove.isPending}
                  onChangeText={setConfirmEmail}
                  placeholder={user?.email ?? ""}
                  purpose="email"
                  value={confirmEmail}
                />
              </Field>
              <Field
                hint="Signed up through a provider without a password? Leave this empty."
                label="Password"
              >
                <Input
                  editable={!remove.isPending}
                  onChangeText={setPassword}
                  purpose="password"
                  value={password}
                />
              </Field>
              {remove.error ? (
                <Text accessibilityRole="alert" color="destructive" variant="body">
                  {remove.error.message}
                </Text>
              ) : null}
              <View style={styles.actions}>
                <Button
                  disabled={!emailMatches}
                  loading={remove.isPending}
                  onPress={() => void deletePermanently()}
                  variant="destructive"
                >
                  {remove.isPending ? "Deleting…" : "Permanently delete"}
                </Button>
                <Button
                  disabled={remove.isPending}
                  onPress={() => {
                    setConfirming(false);
                    setConfirmEmail("");
                    setPassword("");
                    remove.reset();
                  }}
                  variant="secondary"
                >
                  Cancel
                </Button>
              </View>
            </View>
          </Collapse>
        </View>
      </Card>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  accountHeader: {
    marginTop: -spacing[5],
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
  callout: {
    gap: spacing[2],
  },
  danger: {
    gap: spacing[3],
  },
  form: {
    borderTopWidth: borderWidth.hairline,
    gap: spacing[3],
    paddingTop: spacing[3],
  },
  skeleton: {
    height: spacing[32],
  },
});
