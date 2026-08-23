import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import type { AgentOut } from "@/data/api/schemas/agents";
import { spacing } from "@/theme";

interface EnvironmentRow {
  id: number;
  name: string;
  value: string;
}

export interface AgentFormValue {
  name: string;
  kind: string;
  command: string;
  install: string | null;
  yoloArgs: string | null;
  environment: Record<string, string>;
}

export interface AgentFormProps {
  agent?: AgentOut;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (value: AgentFormValue) => Promise<void>;
}

function environmentRows(agent: AgentOut | undefined): EnvironmentRow[] {
  return Object.entries(agent?.env ?? {}).map(([name, value], index) => ({
    id: index + 1,
    name,
    value,
  }));
}

export function AgentForm({ agent, busy, onCancel, onSubmit }: AgentFormProps): React.JSX.Element {
  const [name, setName] = useState(agent?.name ?? "");
  const [kind, setKind] = useState(agent?.kind ?? "custom");
  const [command, setCommand] = useState(agent?.command ?? "");
  const [install, setInstall] = useState(agent?.install ?? "");
  const [yoloArgs, setYoloArgs] = useState(agent?.yolo_args ?? "");
  const [rows, setRows] = useState<EnvironmentRow[]>(() => environmentRows(agent));
  const [nextRowId, setNextRowId] = useState(rows.length + 1);
  const [error, setError] = useState<string | null>(null);

  const duplicateEnvironmentName = useMemo(() => {
    const names = rows.map((row) => row.name.trim()).filter(Boolean);
    return new Set(names).size !== names.length;
  }, [rows]);

  const submit = async () => {
    if (!name.trim() || !kind.trim() || !command.trim()) {
      setError("Name, kind, and command are required.");
      return;
    }
    if (duplicateEnvironmentName) {
      setError("Environment variable names must be unique.");
      return;
    }
    const environment = Object.fromEntries(
      rows.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.value]),
    );
    setError(null);
    await onSubmit({
      name: name.trim(),
      kind: kind.trim(),
      command: command.trim(),
      install: install.trim() || null,
      yoloArgs: yoloArgs.trim() || null,
      environment,
    });
  };

  return (
    <View style={styles.form} testID="agent-form">
      <Field label="Name" required>
        <Input
          editable={!busy}
          maxLength={128}
          onChangeText={setName}
          placeholder="My agent"
          purpose="name"
          value={name}
        />
      </Field>
      <Field label="Kind" required>
        <Input
          editable={!busy}
          maxLength={64}
          onChangeText={setKind}
          placeholder="custom"
          value={kind}
        />
      </Field>
      <Field hint="A single shell command, including arguments." label="Command" required>
        <Input
          editable={!busy}
          maxLength={1024}
          onChangeText={setCommand}
          placeholder="my-agent --interactive"
          value={command}
        />
      </Field>
      <Field label="Install command (optional)">
        <Input
          editable={!busy}
          maxLength={2048}
          onChangeText={setInstall}
          placeholder="npm install -g my-agent"
          value={install}
        />
      </Field>
      <Field label="Yolo arguments (optional)">
        <Input
          editable={!busy}
          maxLength={256}
          onChangeText={setYoloArgs}
          placeholder="--dangerously-skip-permissions"
          value={yoloArgs}
        />
      </Field>

      <View style={styles.environment}>
        <Text variant="label">Environment</Text>
        {rows.map((row) => (
          <View key={row.id} style={styles.environmentRow}>
            <Input
              accessibilityLabel="Environment variable name"
              containerStyle={styles.environmentName}
              editable={!busy}
              onChangeText={(value) =>
                setRows((current) =>
                  current.map((candidate) =>
                    candidate.id === row.id ? { ...candidate, name: value } : candidate,
                  ),
                )
              }
              placeholder="KEY"
              value={row.name}
            />
            <Input
              accessibilityLabel="Environment variable value"
              containerStyle={styles.environmentValue}
              editable={!busy}
              onChangeText={(value) =>
                setRows((current) =>
                  current.map((candidate) =>
                    candidate.id === row.id ? { ...candidate, value } : candidate,
                  ),
                )
              }
              placeholder="value"
              value={row.value}
            />
            <IconButton
              accessibilityLabel="Remove variable"
              disabled={busy}
              icon="X"
              onPress={() =>
                setRows((current) => current.filter((candidate) => candidate.id !== row.id))
              }
              size="sm"
            />
          </View>
        ))}
        <Button
          disabled={busy}
          onPress={() => {
            setRows((current) => [...current, { id: nextRowId, name: "", value: "" }]);
            setNextRowId((current) => current + 1);
          }}
          size="sm"
          variant="outline"
        >
          Add variable
        </Button>
      </View>

      {error ? (
        <Text accessibilityRole="alert" color="destructive" variant="body">
          {error}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button loading={busy} onPress={() => void submit()}>
          {busy ? "Saving…" : agent ? "Save changes" : "Add agent"}
        </Button>
        <Button disabled={busy} onPress={onCancel} variant="secondary">
          Cancel
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
  environment: {
    gap: spacing[2],
  },
  environmentName: {
    flex: 1,
  },
  environmentRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
  environmentValue: {
    flex: 1,
  },
  form: {
    gap: spacing[3],
  },
});
