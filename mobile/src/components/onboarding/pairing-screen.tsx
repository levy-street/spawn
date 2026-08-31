import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";

import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { HostPairingStep } from "@/components/onboarding/host-pairing-step";
import { leaveOnboarding } from "@/components/onboarding/onboarding-navigation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { getMe } from "@/data/api/endpoints/account";
import { qk } from "@/data/queryKeys";
import { chrome, spacing, useTheme } from "@/theme";

export function PairingScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{
    approvalRef?: string | string[];
    hostKey?: string | string[];
    fragmentMalformed?: string | string[];
  }>();
  const approvalRef = Array.isArray(params.approvalRef)
    ? params.approvalRef[0]
    : params.approvalRef;
  const hostKey = Array.isArray(params.hostKey) ? params.hostKey[0] : params.hostKey;
  const fragmentMalformed = Array.isArray(params.fragmentMalformed)
    ? params.fragmentMalformed[0]
    : params.fragmentMalformed;
  const meQuery = useQuery({ queryKey: qk.me(), queryFn: getMe });

  let content: React.ReactNode;
  if (meQuery.isPending) {
    content = (
      <View style={styles.loading}>
        <Spinner label="Loading device trust" />
        <Text color="mutedForeground">Loading device trust…</Text>
      </View>
    );
  } else if (meQuery.isError) {
    content = (
      <EmptyState
        action={<Button onPress={() => void meQuery.refetch()}>Try again</Button>}
        description="Check your connection, then try again."
        icon="AlertCircle"
        title="Couldn’t load your account"
      />
    );
  } else {
    content = (
      <HostPairingStep
        accountId={meQuery.data.user.id}
        {...(approvalRef === undefined ? {} : { initialApprovalRef: approvalRef })}
        {...(hostKey === undefined ? {} : { initialHostKey: hostKey })}
        initialLinkMalformed={fragmentMalformed === "true"}
        onExit={() => leaveOnboarding(router)}
      />
    );
  }

  return (
    <View
      style={[styles.screen, { backgroundColor: theme.colors.background }]}
      testID="pairing-screen"
    >
      <Screen
        header={<AppHeader onBack={() => leaveOnboarding(router)} title="Connect a host" />}
        padded={false}
        scroll
      >
        <View style={styles.content}>{content}</View>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    alignSelf: "center",
    maxWidth: chrome.pickerPreferredWidth,
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[8],
    width: "100%",
  },
  loading: {
    alignItems: "center",
    gap: spacing[3],
    paddingVertical: spacing[12],
  },
  screen: {
    flex: 1,
  },
});
