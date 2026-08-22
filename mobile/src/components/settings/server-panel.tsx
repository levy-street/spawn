import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { authToken } from "@/data/api/auth-token";
import {
  type BaseUrlResolution,
  getBaseUrlResolution,
  normalizeServerUrl,
  setBaseUrl,
} from "@/data/api/config";
import { useConnectionStore } from "@/data/stores/connection";
import { haptics } from "@/lib/haptics";
import { spacing, useTheme } from "@/theme";

type ConnectionResult =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "success"; message: string }
  | { status: "failure"; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unknown error occurred.";
}

export async function testServerConnection(
  baseUrl: string,
  request: typeof fetch = globalThis.fetch,
): Promise<void> {
  const normalized = normalizeServerUrl(baseUrl);
  const response = await request(`${normalized}/healthz`, {
    credentials: "omit",
    headers: { Accept: "application/json" },
    method: "GET",
  });
  if (!response.ok) {
    const status = [response.status, response.statusText].filter(Boolean).join(" ");
    throw new Error(`Server responded with ${status || "an error"}`);
  }
}

export function ServerPanel(): React.JSX.Element {
  const queryClient = useQueryClient();
  const router = useRouter();
  const theme = useTheme();
  const [resolution, setResolution] = useState<BaseUrlResolution | null>(null);
  const [value, setValue] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [connection, setConnection] = useState<ConnectionResult>({ status: "idle" });

  useEffect(() => {
    let active = true;
    void getBaseUrlResolution().then(
      (next) => {
        if (!active) return;
        setResolution(next);
        setValue(next.url);
      },
      (error: unknown) => {
        if (active) setLoadError(errorMessage(error));
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const normalizedValue = (): string | null => {
    try {
      const normalized = normalizeServerUrl(value);
      setValidationError(null);
      return normalized;
    } catch (error) {
      setValidationError(errorMessage(error));
      return null;
    }
  };

  const testConnection = async () => {
    const normalized = normalizedValue();
    if (normalized === null) return;
    setConnection({ status: "testing" });
    try {
      await testServerConnection(normalized);
      setValue(normalized);
      setConnection({ status: "success", message: `Connected to ${normalized}.` });
      haptics.success();
    } catch (error) {
      setConnection({
        status: "failure",
        message: `Connection failed: ${errorMessage(error)}`,
      });
      haptics.error();
    }
  };

  const save = async () => {
    const normalized = normalizedValue();
    if (normalized === null) return;
    setValue(normalized);
    setSaveError(null);
    if (normalized === resolution?.url) return;

    setSaving(true);
    try {
      // The token is keyed by server URL, so it must be cleared before the active URL changes.
      await authToken.clear();
      await setBaseUrl(normalized);
      setResolution({ url: normalized, source: "runtime override" });
      useConnectionStore.getState().reset();
      queryClient.clear();
      haptics.success();
      router.replace("/login");
    } catch (error) {
      setSaveError(errorMessage(error));
      haptics.error();
    } finally {
      setSaving(false);
    }
  };

  const connectionColor = connection.status === "failure" ? "destructive" : "success";

  return (
    <SettingsScreen
      description="Choose the spawn server this device connects to."
      testID="server-panel"
      title="Server"
    >
      <SettingsSection title="Current server">
        <Card style={styles.current} variant="flat">
          {resolution ? (
            <>
              <Text selectable testID="effective-server-url" variant="mono">
                {resolution.url}
              </Text>
              <Badge testID="server-url-source" variant="outline">
                {resolution.source}
              </Badge>
            </>
          ) : (
            <Text color={loadError ? "destructive" : "mutedForeground"} variant="caption">
              {loadError ? `Could not load the current server: ${loadError}` : "Loading…"}
            </Text>
          )}
        </Card>
      </SettingsSection>

      <SettingsSection title="Connection">
        <Field
          error={validationError}
          hint="HTTPS is added when you omit a scheme. HTTP is supported when entered explicitly."
          label="Server URL"
        >
          <Input
            editable={!saving && connection.status !== "testing"}
            error={validationError !== null}
            onChangeText={(next) => {
              setValue(next);
              setValidationError(null);
              setSaveError(null);
              setConnection({ status: "idle" });
            }}
            onSubmitEditing={() => {
              void testConnection();
            }}
            placeholder="https://spawn.example.com"
            purpose="url"
            returnKeyType="go"
            testID="server-url-input"
            value={value}
          />
        </Field>

        {connection.status === "success" || connection.status === "failure" ? (
          <Text
            accessibilityLiveRegion="polite"
            accessibilityRole={connection.status === "failure" ? "alert" : "text"}
            color={connectionColor}
            testID="connection-result"
            variant="caption"
          >
            {connection.message}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <Button
            loading={connection.status === "testing"}
            onPress={() => void testConnection()}
            variant="outline"
          >
            {connection.status === "testing" ? "Testing…" : "Test connection"}
          </Button>
          <Button loading={saving} onPress={() => void save()}>
            {saving ? "Saving…" : "Save server"}
          </Button>
        </View>
      </SettingsSection>

      <Card
        style={[styles.warning, { borderColor: theme.colors.warning }]}
        testID="server-change-warning"
        variant="flat"
      >
        <Text variant="label">Changing the server signs you out</Text>
        <Text color="mutedForeground" variant="caption">
          Your current session and live connections on this device will close. You can sign in to
          the new server after saving.
        </Text>
        {saveError ? (
          <Text accessibilityRole="alert" color="destructive" variant="caption">
            Could not save the server: {saveError}
          </Text>
        ) : null}
      </Card>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
  current: {
    gap: spacing[3],
  },
  warning: {
    gap: spacing[2],
  },
});
