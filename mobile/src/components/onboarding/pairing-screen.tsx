import { useQuery } from "@tanstack/react-query";
import { StyleSheet, View } from "react-native";

import { HostPairingStep } from "@/components/onboarding/host-pairing-step";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { getMe } from "@/data/api/endpoints/account";
import { qk } from "@/data/queryKeys";
import { chrome, spacing, useTheme } from "@/theme";

export function PairingScreen() {
  const theme = useTheme();
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
    content = <HostPairingStep accountId={meQuery.data.user.id} />;
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.colors.background }]}>
      <View style={styles.content}>{content}</View>
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
