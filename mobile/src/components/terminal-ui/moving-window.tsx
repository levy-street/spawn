import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { createMoveDeps } from "@/components/workspace-detail/move-channels";
import * as copy from "@/components/workspace-detail/move-copy";
import type { ResolveOutcome } from "@/components/workspace-detail/move-resolve";
import { useResolveMove } from "@/components/workspace-detail/use-resolve-move";
import { listHosts } from "@/data/api/endpoints/hosts";
import { qk } from "@/data/queryKeys";
import type { AgentDef, Session } from "@/data/types/domain";
import { useTheme } from "@/theme";

/**
 * A window that a device is carrying to another host, opened full screen.
 * No terminal attaches to the host it is leaving, and nothing that would act
 * on it is offered: it reads "Moving to another host…" with Resolve, which
 * asks first, then finishes the move or puts it back from the hosts' own
 * records. The device moving it shows its own progress instead.
 */
export function MovingWindow({
  session,
  agents,
  onBack,
  onResolving,
  onSettled,
}: {
  session: Session;
  agents: readonly AgentDef[];
  onBack: () => void;
  /** Resolve was confirmed here: this device may finish the move. */
  onResolving: () => void;
  /** Resolve ended; `finished` means the window runs on its new host,
   *  its resume this device's to type. */
  onSettled: (outcome: ResolveOutcome) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const client = useQueryClient();
  const hosts = useQuery({ queryKey: qk.hosts(), queryFn: listHosts });
  const deps = useMemo(() => createMoveDeps(client, agents), [agents, client]);
  const resolver = useResolveMove({
    agents,
    hosts: hosts.data ?? [],
    deps,
    onResolving: () => onResolving(),
    onSettled: (_session, outcome) => {
      void client.invalidateQueries({ queryKey: qk.sessions() });
      void client.invalidateQueries({ queryKey: qk.session(session.id) });
      onSettled(outcome);
    },
  });

  return (
    <Screen
      header={<AppHeader onBack={onBack} title={session.name ?? "Terminal"} />}
      padded={false}
    >
      <View
        style={[
          styles.center,
          {
            backgroundColor: theme.colors.background,
            gap: theme.space(3),
            padding: theme.space(6),
          },
        ]}
        testID="moving-window"
      >
        <Text accessibilityRole="header" variant="title">
          {copy.MOVE_MOVING_STATUS}
        </Text>
        <Button onPress={() => resolver.open(session)} variant="outline">
          {copy.MOVE_RESOLVE}
        </Button>
      </View>
      {resolver.sheet}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
});
