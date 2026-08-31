import { StyleSheet, View } from "react-native";

import { SettingsBlock } from "@/components/settings/settings-block";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useMeSettingsQuery } from "@/data/queries/settings";
import {
  BILLING_VENUE_NOTE,
  billingActive,
  planCapacityLine,
  planRenewalLine,
} from "@/data/selectors/billing";
import { spacing } from "@/theme";

/**
 * Subscription, read-only — and read-only is the entire design.
 *
 * The mobile apps never sell anything (docs/BILLING.md §6.1). This panel shows
 * tier name, capacity and renewal date: account state describing something
 * already bought, which is exactly what a store's rules allow. It shows no
 * price, offers no purchase, and opens nothing outside the app.
 *
 * The closing line is passive on purpose. It names no venue, carries no verb
 * aimed at the reader, and reads as an explanation for the absence of a button
 * rather than an inducement to press one. Do not improve it into an
 * instruction — "Manage your plan on the web" is the phrasing that fails.
 *
 * The route is only reachable while the deployment has billing on; this guards
 * it again for a deep link and for a plan block that arrives after the row did.
 *
 * **On `billing.mobile_upgrade_link`.** The flag is parsed and defaults to
 * false, and nothing here consults it, because there is nothing behind it to
 * consult: no upgrade route ships at all. That still meets §6.1's requirement
 * that turning the link on must not need an App Store submission — this is an
 * Expo app, and a JS-only change reaches phones through `eas update`
 * (docs/RELEASE.md), so the affordance can be added the day the law settles.
 * A dormant purchase path inside a binary that cannot be recalled buys nothing
 * and risks precisely what §6.1 exists to avoid.
 */
export function SubscriptionPanel(): React.JSX.Element {
  const me = useMeSettingsQuery();
  const billing = me.data?.user.billing ?? null;

  return (
    <SettingsScreen testID="subscription-panel" title="Subscription">
      <SettingsSection>
        <SettingsBlock testID="subscription-plan">
          <Text variant="label">Plan</Text>
          {me.isPending ? (
            <Skeleton style={styles.loading} />
          ) : billingActive(billing) ? (
            <View style={styles.copy}>
              <Text color="mutedForeground">{planCapacityLine(billing)}</Text>
              {planRenewalLine(billing) === null ? null : (
                <Text color="mutedForeground">{planRenewalLine(billing)}</Text>
              )}
              <Text color="mutedForeground" variant="caption">
                {BILLING_VENUE_NOTE}
              </Text>
            </View>
          ) : (
            // A deployment with billing off has no plan to describe, and this
            // screen is not linked from anywhere in that state.
            <Text color="mutedForeground">This server has no subscriptions.</Text>
          )}
        </SettingsBlock>
      </SettingsSection>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  copy: {
    gap: spacing[1],
  },
  loading: {
    height: spacing[4],
    width: "60%",
  },
});
