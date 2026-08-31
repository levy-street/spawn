import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { BackHandler, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { formatHostOS, relativeSeen } from "@/components/hosts/host-model";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import type { HostOut } from "@/data/api/schemas/hosts";
import { removeHostWithTrust, useHostsQuery } from "@/data/queries/hosts";
import { useMeSettingsQuery } from "@/data/queries/settings";
import { qk } from "@/data/queryKeys";
import {
  billingActive,
  OVER_LIMIT_TITLE,
  overLimitDescription,
  selectionCountLine,
} from "@/data/selectors/billing";
import { borderWidth, opacity, spacing, useTheme } from "@/theme";

/**
 * The account holds more hosts than its plan admits. The user chooses which to
 * keep — or keeps none — and the choice is mandatory.
 *
 * Three paths reach this state without anyone changing plan on purpose: a
 * cancellation through the portal, a subscription that lapses to `unpaid`, and
 * an admin removing a comp. Nothing is suspended and nothing is deleted on a
 * billing signal; the excess is resolved by a person, and until then every
 * machine keeps running. docs/BILLING.md §5.7 and §11.1.
 *
 * **This ships on the phone deliberately.** Releasing a host is host
 * management, not commerce — no price, no venue, no purchase verb — so there is
 * no store-policy obstacle, and someone whose only device is a phone must not
 * be stranded holding hosts they cannot reduce.
 *
 * It cannot be dismissed until a choice is made: no close control, no scrim to
 * tap, no swipe, and Android's hardware back is swallowed twice over — the
 * modal's own `onRequestClose` does nothing, and a `BackHandler` guard claims
 * the press for as long as this is on screen. `ui/dialog.tsx` is deliberately
 * not used: every dialog in the app can be swiped away, which is right for a
 * dialog and wrong for this.
 */
export function OverLimitReconciliation(): React.JSX.Element | null {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const me = useMeSettingsQuery();
  const billing = me.data?.user.billing ?? null;
  const owed = billingActive(billing) && billing.over_limit;
  // This component is mounted for the whole signed-in session, so the host
  // list is fetched only while the choice is actually owed — an always-on
  // observer would put its ten-second poll under every screen in the app.
  const hostsQuery = useHostsQuery(owed);
  const hosts = hostsQuery.data ?? [];
  const [keep, setKeep] = useState<ReadonlySet<string>>(new Set());
  const [decided, setDecided] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const limit = billingActive(billing) ? (billing.host_limit ?? 0) : 0;

  const release = useMutation({
    mutationFn: async (doomed: readonly HostOut[]) => {
      // One at a time: each release frees a slot on the server synchronously,
      // and a partial failure then has a clear edge — the hosts before it are
      // gone, the rest are untouched, and the list the modal redraws is true.
      for (const host of doomed) await removeHostWithTrust(host);
    },
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: qk.hosts() });
      void queryClient.invalidateQueries({ queryKey: qk.sessions() });
      // Clears `over_limit` and takes this modal off screen with it.
      void queryClient.invalidateQueries({ queryKey: qk.me() });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Some hosts could not be released.");
      void queryClient.invalidateQueries({ queryKey: qk.hosts() });
      void queryClient.invalidateQueries({ queryKey: qk.me() });
    },
  });

  // Android's hardware back, claimed for as long as this stands. The modal's
  // own `onRequestClose` already does nothing; this holds the press even if the
  // surface is ever re-hosted outside a native modal.
  useEffect(() => {
    if (!owed) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => subscription.remove();
  }, [owed]);

  if (!owed) return null;

  const kept = hosts.filter((host) => keep.has(host.id));
  const doomed = hosts.filter((host) => !keep.has(host.id));
  const atCap = kept.length >= limit;

  const toggle = (host: HostOut) => {
    setDecided(true);
    setError(null);
    setKeep((current) => {
      const next = new Set(current);
      if (next.has(host.id)) next.delete(host.id);
      else if (next.size < limit) next.add(host.id);
      return next;
    });
  };

  return (
    <Modal
      animationType="fade"
      // Nothing. Android's back button is not a way out of a choice that has to
      // be made, and there is no other close affordance on this surface.
      onRequestClose={() => undefined}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent={false}
      visible
    >
      <View
        style={[
          styles.window,
          {
            backgroundColor: theme.colors.background,
            paddingBottom: insets.bottom + spacing[4],
            paddingTop: insets.top + spacing[4],
          },
        ]}
        testID="over-limit-reconciliation"
      >
        <View style={styles.heading}>
          <Text accessibilityRole="header" variant="title">
            {OVER_LIMIT_TITLE}
          </Text>
          <Text color="mutedForeground">{overLimitDescription(billing)}</Text>
        </View>

        <ScrollView contentContainerStyle={styles.list}>
          {hostsQuery.isPending ? (
            <View style={styles.loading}>
              <Spinner label="Loading hosts" />
            </View>
          ) : (
            hosts.map((host) => {
              const selected = keep.has(host.id);
              const full = !selected && atCap;
              return (
                <Pressable
                  accessibilityLabel={`Keep ${host.name}`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selected, disabled: full }}
                  disabled={full || release.isPending}
                  key={host.id}
                  onPress={() => toggle(host)}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      backgroundColor: selected
                        ? theme.colors.accent
                        : pressed
                          ? theme.colors.muted
                          : theme.colors.card,
                      borderColor: selected ? theme.colors.ring : theme.colors.border,
                      borderRadius: theme.radii.lg,
                      opacity: full ? opacity.disabled : opacity.opaque,
                    },
                  ]}
                >
                  <View style={styles.rowCopy}>
                    <Text numberOfLines={1} variant="label">
                      {host.name}
                    </Text>
                    <Text color="mutedForeground" numberOfLines={1} variant="caption">
                      {`${formatHostOS(host.os)} · last seen ${relativeSeen(host.last_seen_at)}`}
                    </Text>
                  </View>
                  {selected ? <Icon color="foreground" name="Check" size={spacing[4]} /> : null}
                </Pressable>
              );
            })
          )}
        </ScrollView>

        <View style={styles.footer}>
          <Text color="mutedForeground" testID="over-limit-count" variant="caption">
            {selectionCountLine(kept.length, limit)}
          </Text>
          {error === null ? null : (
            <Text accessibilityRole="alert" color="destructive" variant="caption">
              {error}
            </Text>
          )}
          <Button
            disabled={!decided || hostsQuery.isPending}
            loading={release.isPending}
            onPress={() => release.mutate(doomed)}
          >
            {doomed.length === 1 ? "Release 1 host" : `Release ${doomed.length} hosts`}
          </Button>
          {/* Keeping none is a real answer, offered as plainly as the others.
              It arms the release rather than performing it, so the most
              far-reaching choice still takes a second, deliberate press. */}
          <Button
            disabled={release.isPending}
            onPress={() => {
              setKeep(new Set());
              setDecided(true);
              setError(null);
            }}
            variant="outline"
          >
            Keep none
          </Button>
          <Text color="mutedForeground" variant="caption">
            Released machines stop being reachable here. They keep their claim on this account, so
            the same machine can be connected again later.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  footer: {
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
  },
  heading: {
    gap: spacing[2],
    paddingHorizontal: spacing[4],
  },
  list: {
    gap: spacing[2],
    padding: spacing[4],
  },
  loading: {
    alignItems: "center",
    paddingVertical: spacing[8],
  },
  row: {
    alignItems: "center",
    borderWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: spacing[3],
    padding: spacing[3],
  },
  rowCopy: {
    flex: 1,
    gap: spacing[1],
  },
  window: {
    flex: 1,
    gap: spacing[3],
  },
});
