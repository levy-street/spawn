import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { AgentForm, type AgentFormValue } from "@/components/settings/agent-form";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import type { AgentOut } from "@/data/api/schemas/agents";
import { useAgentMutations, useAgentsSettingsQuery } from "@/data/queries/settings";
import { spacing } from "@/theme";

function hasYoloMode(agent: AgentOut): boolean {
  return Boolean(agent.yolo_args) || Object.keys(agent.yolo_env).length > 0;
}

function AgentRow({
  agent,
  onEdit,
  onDelete,
  onYoloChange,
  busy,
}: {
  agent: AgentOut;
  onEdit: () => void;
  onDelete: () => void;
  onYoloChange: (value: boolean) => void;
  busy: boolean;
}): React.JSX.Element {
  const custom = agent.owner_user_id !== null;
  const canYolo = hasYoloMode(agent);
  return (
    <Card variant="flat">
      <View style={styles.row}>
        <View style={styles.rowCopy}>
          <View style={styles.titleLine}>
            <Text variant="label">{agent.name}</Text>
            {!custom ? <Badge variant="outline">read only</Badge> : null}
          </View>
          <Text color="mutedForeground" numberOfLines={2} variant="mono">
            {agent.command}
          </Text>
          <Text color="mutedForeground" variant="caption">
            {canYolo
              ? `Run ${agent.name} without permission prompts`
              : `${agent.name} has no way to skip its permission prompts`}
          </Text>
        </View>
        <Switch
          accessibilityLabel={`Run ${agent.name} without permission prompts`}
          disabled={!canYolo || busy}
          onValueChange={onYoloChange}
          value={agent.yolo}
        />
      </View>
      {custom ? (
        <View style={styles.actions}>
          <Button disabled={busy} onPress={onEdit} size="sm" variant="outline">
            Edit
          </Button>
          <Button disabled={busy} onPress={onDelete} size="sm" variant="ghost">
            Delete
          </Button>
        </View>
      ) : null}
    </Card>
  );
}

export function AgentsPanel(): React.JSX.Element {
  const agents = useAgentsSettingsQuery();
  const mutations = useAgentMutations();
  const [editing, setEditing] = useState<AgentOut | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const builtIn = (agents.data ?? []).filter((agent) => agent.owner_user_id === null);
  const custom = (agents.data ?? []).filter((agent) => agent.owner_user_id !== null);
  const busy =
    mutations.create.isPending ||
    mutations.patch.isPending ||
    mutations.remove.isPending ||
    mutations.preference.isPending;

  const save = async (value: AgentFormValue) => {
    setError(null);
    try {
      if (editing === "new") {
        await mutations.create.mutateAsync({
          name: value.name,
          kind: value.kind,
          command: value.command,
          env: value.environment,
          install: value.install,
          yolo_args: value.yoloArgs,
        });
      } else if (editing) {
        await mutations.patch.mutateAsync({
          id: editing.id,
          patch: {
            name: value.name,
            kind: value.kind,
            command: value.command,
            env: value.environment,
            install: value.install,
            yolo_args: value.yoloArgs,
          },
        });
      }
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save agent.");
    }
  };

  return (
    <SettingsScreen
      description="Agents are account-level shortcut definitions that type CLI commands into a session shell."
      testID="agents-panel"
      title="Agents"
    >
      {editing ? (
        <Card variant="flat">
          <AgentForm
            {...(editing === "new" ? {} : { agent: editing })}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSubmit={save}
          />
        </Card>
      ) : (
        <Button onPress={() => setEditing("new")}>Add agent</Button>
      )}

      {error || agents.error ? (
        <Text accessibilityRole="alert" color="destructive" variant="body">
          {error ?? agents.error?.message}
        </Text>
      ) : null}

      <SettingsSection title="BUILT IN">
        {builtIn.map((agent) => (
          <AgentRow
            agent={agent}
            busy={busy}
            key={agent.id}
            onDelete={() => undefined}
            onEdit={() => undefined}
            onYoloChange={(yolo) =>
              mutations.preference.mutate(
                { id: agent.id, yolo },
                { onError: (cause) => setError(cause.message) },
              )
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection title="CUSTOM AGENTS">
        {custom.length === 0 && !agents.isPending ? (
          <EmptyState
            description="Add a shortcut for any CLI tool installed on your hosts."
            icon="Bot"
            title="No custom agents"
          />
        ) : (
          custom.map((agent) => (
            <AgentRow
              agent={agent}
              busy={busy}
              key={agent.id}
              onDelete={() => setDeleteTarget(agent)}
              onEdit={() => setEditing(agent)}
              onYoloChange={(yolo) =>
                mutations.preference.mutate(
                  { id: agent.id, yolo },
                  { onError: (cause) => setError(cause.message) },
                )
              }
            />
          ))
        )}
      </SettingsSection>

      <Confirm
        confirmLabel="Delete agent"
        description="This removes the shortcut definition. Running sessions are not affected."
        destructive
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          mutations.remove.mutate(deleteTarget.id, {
            onSuccess: () => setDeleteTarget(null),
            onError: (cause) => setError(cause.message),
          });
        }}
        title={`Delete ${deleteTarget?.name ?? "agent"}?`}
        visible={deleteTarget !== null}
      />
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    gap: spacing[2],
    marginTop: spacing[3],
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
  },
  rowCopy: {
    flex: 1,
    gap: spacing[1],
    minWidth: 0,
  },
  titleLine: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
});
