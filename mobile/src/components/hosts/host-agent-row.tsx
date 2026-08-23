import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { ListBlock } from "@/components/ui/list-group";
import { Monogram } from "@/components/ui/monogram";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import type { HostAgentInstallResult, HostAgentStatus } from "@/data/api/schemas/hosts";
import { spacing, useTheme } from "@/theme";

export interface HostAgentRowProps {
  agent: HostAgentStatus;
  hostName: string;
  installing: boolean;
  policySaving: boolean;
  result?: HostAgentInstallResult | null;
  onInstall(): void;
  onPolicyChange(value: boolean): void;
}

export function HostAgentRow({
  agent,
  hostName,
  installing,
  policySaving,
  result,
  onInstall,
  onPolicyChange,
}: HostAgentRowProps) {
  const theme = useTheme();
  const [confirmVisible, setConfirmVisible] = useState(false);
  const action = agent.installed ? "Update" : "Install";
  const canInstall = Boolean(agent.install?.trim());
  return (
    <ListBlock bleed={false} testID={`host-agent-${agent.agent_id}`}>
      <View style={styles.heading}>
        <Monogram seed={agent.agent_name} size={spacing[8]} />
        <View style={styles.headingCopy}>
          <Text variant="label">{agent.agent_name}</Text>
          <Text color="mutedForeground" variant="caption">
            {agent.command}
          </Text>
        </View>
        {!agent.installed ? (
          <Badge variant="outline">not installed</Badge>
        ) : agent.update_available ? (
          <Badge variant="warning">{`update ${agent.latest_version ?? "available"}`}</Badge>
        ) : agent.version ? (
          <Badge variant="success">{agent.version}</Badge>
        ) : null}
      </View>
      {agent.error ? (
        <Text accessibilityRole="alert" color="destructive" variant="caption">
          {agent.error}
        </Text>
      ) : null}
      {agent.last_auto_update_error ? (
        <Text accessibilityRole="alert" color="destructive" variant="caption">
          Last auto-update: {agent.last_auto_update_error}
        </Text>
      ) : null}
      <Text color="mutedForeground" variant="caption">
        {agent.installed
          ? (agent.path ?? agent.command)
          : (agent.install ?? "No install command is available.")}
      </Text>
      <View style={styles.controls}>
        <View style={styles.policyCopy}>
          <Text variant="body">Auto update</Text>
          {!canInstall ? (
            <Text color="mutedForeground" variant="caption">
              No install command
            </Text>
          ) : null}
        </View>
        <Switch
          accessibilityLabel={`Auto update ${agent.agent_name}`}
          disabled={!canInstall || policySaving}
          onValueChange={onPolicyChange}
          value={agent.auto_update}
        />
        <Button
          disabled={!canInstall}
          loading={installing}
          onPress={() => setConfirmVisible(true)}
          size="sm"
          variant={agent.installed ? "outline" : "default"}
        >
          {action}
        </Button>
      </View>
      {result ? (
        <View
          style={[
            styles.result,
            {
              backgroundColor: result.success
                ? theme.colors.successSoft
                : theme.colors.destructiveSoft,
              borderRadius: theme.radii.md,
            },
          ]}
        >
          <Text color={result.success ? "success" : "destructive"} variant="caption">
            {result.agent_name}: {result.success ? "completed" : "failed"}
            {result.error ? ` · ${result.error}` : ""}
          </Text>
          {result.output ? (
            <Text selectable variant="mono">
              {result.output}
            </Text>
          ) : null}
        </View>
      ) : null}
      <Confirm
        confirmLabel={action}
        description={`Runs the install command on ${hostName}.`}
        onCancel={() => setConfirmVisible(false)}
        onConfirm={() => {
          setConfirmVisible(false);
          onInstall();
        }}
        title={`${action} ${agent.agent_name}?`}
        visible={confirmVisible}
      />
    </ListBlock>
  );
}

const styles = StyleSheet.create({
  controls: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
  heading: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
  },
  headingCopy: {
    flex: 1,
    gap: spacing[1],
    minWidth: 0,
  },
  policyCopy: {
    flex: 1,
  },
  result: {
    gap: spacing[2],
    padding: spacing[3],
  },
});
