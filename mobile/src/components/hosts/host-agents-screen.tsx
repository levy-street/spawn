import { useRouter } from "expo-router";
import { useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { HostAgentRow } from "@/components/hosts/host-agent-row";
import { errorMessage } from "@/components/hosts/host-model";
import { HostSkillsList } from "@/components/hosts/host-skills-list";
import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import type { HostAgentInstallResult } from "@/data/api/schemas/hosts";
import {
  useHostAgentPolicyMutation,
  useHostAgentsQuery,
  useHostQuery,
  useInstallHostAgentMutation,
  useSkillsQuery,
} from "@/data/queries/hosts";
import { spacing, useTheme } from "@/theme";

export function HostAgentsScreen({ hostId }: { hostId: string }) {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const hostQuery = useHostQuery(hostId);
  const host = hostQuery.data;
  const online = host?.status === "online";
  const agentsQuery = useHostAgentsQuery(hostId, online);
  const skillsQuery = useSkillsQuery();
  const install = useInstallHostAgentMutation(hostId);
  const policy = useHostAgentPolicyMutation(hostId);
  const [results, setResults] = useState<Record<string, HostAgentInstallResult>>({});

  const refresh = () => {
    void Promise.all([
      hostQuery.refetch(),
      ...(online ? [agentsQuery.refetch()] : []),
      skillsQuery.refetch(),
    ]);
  };

  return (
    <Screen
      header={
        <AppHeader
          actions={[
            {
              accessibilityLabel: "Refresh agents and skills",
              icon: "RefreshCw",
              onPress: refresh,
            },
          ]}
          onBack={router.back}
          {...(host === undefined ? {} : { subtitle: host.name })}
          title="Agents & skills"
        />
      }
      padded={false}
    >
      <View style={[styles.screen, { backgroundColor: theme.colors.background }]}>
        {hostQuery.isPending ? (
          <View style={styles.centered}>
            <Spinner label="Loading host" />
          </View>
        ) : hostQuery.isError || !host ? (
          <EmptyState
            action={<Button onPress={() => void hostQuery.refetch()}>Retry</Button>}
            description={`Failed to load host: ${errorMessage(hostQuery.error)}`}
            icon="AlertCircle"
            title="Host unavailable"
          />
        ) : (
          <ScrollView
            contentContainerStyle={styles.content}
            refreshControl={
              <RefreshControl
                onRefresh={refresh}
                refreshing={
                  hostQuery.isRefetching || agentsQuery.isRefetching || skillsQuery.isRefetching
                }
                tintColor={theme.colors.mutedForeground}
              />
            }
          >
            <View style={styles.section}>
              <SectionHeader
                style={styles.sectionHeader}
                title="Agent availability"
                trailing={
                  online ? (
                    <Button onPress={() => void agentsQuery.refetch()} size="sm" variant="ghost">
                      Refresh
                    </Button>
                  ) : undefined
                }
              />
              {!online ? (
                <View
                  style={[
                    styles.callout,
                    { backgroundColor: theme.colors.muted, borderRadius: theme.radii.lg },
                  ]}
                >
                  <Text color="mutedForeground" variant="body">
                    Agent availability is unavailable while the daemon is offline.
                  </Text>
                </View>
              ) : agentsQuery.isPending ? (
                <View style={styles.loadingRow}>
                  <Spinner label="Checking agent availability" />
                  <Text color="mutedForeground" variant="body">
                    Checking agents…
                  </Text>
                </View>
              ) : agentsQuery.isError ? (
                <View style={styles.errorBlock}>
                  <Text accessibilityRole="alert" color="destructive" variant="body">
                    {errorMessage(agentsQuery.error)}
                  </Text>
                  <Button onPress={() => void agentsQuery.refetch()} size="sm" variant="outline">
                    Retry
                  </Button>
                </View>
              ) : agentsQuery.data.agents.length === 0 ? (
                <EmptyState icon="Bot" title="No agent definitions are available." />
              ) : (
                <View style={styles.agentList}>
                  {agentsQuery.data.agents.map((agent) => (
                    <HostAgentRow
                      agent={agent}
                      hostName={host.name}
                      installing={
                        install.isPending && install.variables?.agentId === agent.agent_id
                      }
                      key={agent.agent_id}
                      onInstall={() => {
                        install.mutate(
                          { agentId: agent.agent_id, hostId },
                          {
                            onError: (error) =>
                              toast.error(`${agent.agent_name}: failed`, { detail: error.message }),
                            onSuccess: (result) => {
                              setResults((current) => ({
                                ...current,
                                [agent.agent_id]: result,
                              }));
                              if (result.success) toast.success(`${agent.agent_name}: completed`);
                              else
                                toast.error(
                                  `${agent.agent_name}: failed`,
                                  result.error ? { detail: result.error } : {},
                                );
                            },
                          },
                        );
                      }}
                      onPolicyChange={(value) => {
                        policy.mutate(
                          { agentId: agent.agent_id, autoUpdate: value, hostId },
                          {
                            onError: (error) =>
                              toast.error("Could not update auto update", {
                                detail: error.message,
                              }),
                          },
                        );
                      }}
                      policySaving={
                        policy.isPending && policy.variables?.agentId === agent.agent_id
                      }
                      result={results[agent.agent_id] ?? null}
                    />
                  ))}
                </View>
              )}
            </View>
            {skillsQuery.isPending ? (
              <View style={styles.loadingRow}>
                <Spinner label="Loading skills" />
                <Text color="mutedForeground" variant="body">
                  Loading skills...
                </Text>
              </View>
            ) : skillsQuery.isError ? (
              <View style={styles.errorBlock}>
                <Text accessibilityRole="alert" color="destructive" variant="body">
                  Failed to load skills: {errorMessage(skillsQuery.error)}
                </Text>
                <Button onPress={() => void skillsQuery.refetch()} size="sm" variant="outline">
                  Retry
                </Button>
              </View>
            ) : (
              <HostSkillsList skills={skillsQuery.data} />
            )}
          </ScrollView>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  agentList: {
    gap: spacing[3],
  },
  callout: {
    padding: spacing[4],
  },
  centered: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  content: {
    gap: spacing[8],
    padding: spacing[4],
    paddingBottom: spacing[8],
  },
  errorBlock: {
    alignItems: "flex-start",
    gap: spacing[2],
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
  screen: {
    flex: 1,
  },
  section: {
    gap: spacing[3],
  },
  sectionHeader: {
    paddingHorizontal: spacing[0],
  },
});
