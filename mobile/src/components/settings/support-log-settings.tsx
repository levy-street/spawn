import { NavigationContext } from "@react-navigation/native";
import {
  Component,
  type PropsWithChildren,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";
import { AppState, View } from "react-native";
import { SettingsToggleRow } from "@/components/settings/settings-row";
import { SettingsSection } from "@/components/settings/settings-section";
import copy from "@/components/settings/support-log-copy.json";
import { Text } from "@/components/ui/text";
import { collectionLine } from "@/data/api/endpoints/support-log";
import { useSupportLog } from "@/data/queries/support-log";

function subscribeApp(listener: () => void) {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
}

class SupportLogBoundary extends Component<PropsWithChildren> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function SupportLogSettings({ accountId }: { accountId: string }) {
  return (
    <SupportLogBoundary>
      <SupportLogPanel accountId={accountId} />
    </SupportLogBoundary>
  );
}

function SupportLogPanel({ accountId }: { accountId: string }) {
  // The tab navigator can keep Account mounted behind another screen.
  const navigation = useContext(NavigationContext);
  const subscribe = useCallback(
    (listener: () => void) => {
      const focus = navigation?.addListener("focus", listener);
      const blur = navigation?.addListener("blur", listener);
      return () => {
        focus?.();
        blur?.();
      };
    },
    [navigation],
  );
  const focused = useSyncExternalStore(subscribe, () => navigation?.isFocused() ?? true);
  const active = useSyncExternalStore(
    subscribeApp,
    () => AppState.currentState == null || AppState.currentState === "active",
  );
  return focused && active ? <VisibleSupportLog accountId={accountId} /> : null;
}

function VisibleSupportLog({ accountId }: { accountId: string }) {
  const { state, hasIdentity, change, busy, message } = useSupportLog(accountId);
  if (!state) return null;
  return (
    <SettingsSection title={copy.title}>
      <SettingsToggleRow
        label={copy.switchLabel}
        hint={copy.description}
        value={state.sharing === "on"}
        onValueChange={change}
        disabled={busy || hasIdentity !== true}
      />
      {hasIdentity === false && <Text>{copy.cannotSign}</Text>}
      {state.sharing === "off_signer_removed" && <Text>{copy.offSignerRemoved}</Text>}
      {message && <Text accessibilityLiveRegion="polite">{message}</Text>}
      {state.hosts
        .filter((host) => !host.capable)
        .map((host) => (
          <Text key={host.id}>{copy.needsUpdate.replace("{machine}", () => host.name)}</Text>
        ))}
      <Text variant="label">{copy.collected}</Text>
      {state.collections.length === 0 && <Text>{copy.empty}</Text>}
      {state.collections.map((row) => (
        <View key={row.id}>
          <Text>{collectionLine(row)}</Text>
          <Text color="mutedForeground">{copy.reason.replace("{reason}", () => row.reason)}</Text>
        </View>
      ))}
      <Text color="mutedForeground" variant="caption">
        {copy.help}
      </Text>
    </SettingsSection>
  );
}
