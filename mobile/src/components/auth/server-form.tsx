import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { AuthAction } from "@/components/auth/auth-actions";
import { AuthField, AuthInput } from "@/components/auth/auth-field";
import { AuthMessage } from "@/components/auth/auth-message";
import { useAuthBack } from "@/components/auth/auth-navigation";
import { AuthBlock, AuthRule, AuthShell } from "@/components/auth/auth-shell";
import { testServerConnection } from "@/components/settings/server-panel";
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
import { fontFamily, fontSize, spacing } from "@/theme";

type ConnectionResult =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "success"; message: string }
  | { status: "failure"; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unknown error occurred.";
}

/**
 * The server switch as an account screen rather than a settings page. It is
 * reachable while signed out — a wrong address is a deadlock otherwise — so it
 * is printed on the same sheet as sign-in instead of dropping the one screen in
 * the signed-out flow into the app's own chrome.
 */
export function SignedOutServerScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const router = useRouter();
  const goBack = useAuthBack();
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
      setConnection({ status: "failure", message: `Connection failed: ${errorMessage(error)}` });
      haptics.error();
    }
  };

  const save = async () => {
    const normalized = normalizedValue();
    if (normalized === null) return;
    setValue(normalized);
    setSaveError(null);
    if (normalized === resolution?.url) {
      router.replace("/login");
      return;
    }

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

  const busy = saving || connection.status === "testing";

  return (
    <AuthShell
      description="Point this device at the spawnd you run. Changing it closes the session and live connections on this device."
      onBack={goBack}
      title="Server"
    >
      <View>
        <AuthRule />
        <AuthBlock style={styles.current}>
          <Text color="mutedForeground" variant="sigilLabel">
            Now pointing at
          </Text>
          {resolution ? (
            <>
              <Text selectable style={styles.url} testID="effective-server-url">
                {resolution.url}
              </Text>
              <Text color="mutedForeground" testID="server-url-source" variant="sigilLabel">
                {resolution.source}
              </Text>
            </>
          ) : (
            <Text color={loadError ? "destructive" : "mutedForeground"} variant="caption">
              {loadError ? `Could not load the current server: ${loadError}` : "Loading…"}
            </Text>
          )}
        </AuthBlock>
        <AuthRule />
      </View>
      <AuthField
        error={validationError}
        hint="HTTPS unless you type http:// yourself."
        label="Server URL"
      >
        <AuthInput
          editable={!busy}
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
      </AuthField>
      {connection.status === "success" || connection.status === "failure" ? (
        <AuthMessage tone={connection.status === "failure" ? "error" : "success"}>
          <Text testID="connection-result">{connection.message}</Text>
        </AuthMessage>
      ) : null}
      {saveError !== null ? (
        <AuthMessage tone="error">Could not save the server: {saveError}</AuthMessage>
      ) : null}
      <AuthBlock style={styles.actions}>
        <AuthAction
          label={saving ? "Saving…" : "Save server"}
          loading={saving}
          onPress={() => void save()}
        />
        <AuthAction
          disabled={saving}
          label={connection.status === "testing" ? "Testing…" : "Test connection"}
          loading={connection.status === "testing"}
          onPress={() => void testConnection()}
          tone="quiet"
        />
      </AuthBlock>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: spacing[3],
  },
  current: {
    gap: spacing[2],
    paddingVertical: spacing[5],
  },
  url: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.fifteen,
  },
});
