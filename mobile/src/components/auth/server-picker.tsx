import { useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { AuthAction } from "@/components/auth/auth-actions";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { type TabSwipe, UnderlineTabs } from "@/components/ui/underline-tabs";
import { getBaseUrlResolution, normalizeServerUrl, setBaseUrl } from "@/data/api/config";
import { testServerConnection } from "@/data/api/health";
import { haptics } from "@/lib/haptics";
import { spacing } from "@/theme";

export type ServerChoice = "spawnd" | "custom";

export const SERVER_CHOICES = [
  { value: "spawnd", label: "spawnd.dev" },
  { value: "custom", label: "Self-hosted" },
] as const satisfies readonly { value: ServerChoice; label: string }[];

type Probe =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "connected"; url: string }
  | { status: "failed"; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unknown error occurred.";
}

export interface ServerPickerOptions {
  /** A swipe across the page, for the strip's indicator to follow and finish. */
  swipe?: TabSwipe;
}

export interface ServerPicker {
  /** The two tabs. Set at the very top of the sheet, above the lockup. */
  tabs: ReactElement;
  /** Which tab is up. */
  choice: ServerChoice;
  /** Move to the neighbouring tab, if there is one that way. */
  step: (delta: -1 | 1) => void;
  /** The self-hosted address and its connect control; null on the hosted tab. */
  field: ReactElement | null;
  /**
   * Whether the sign-in may go ahead. False while a self-hosted server has
   * been chosen but not yet reached — signing in to the old one from there
   * would be the wrong server without saying so.
   */
  ready: boolean;
}

/**
 * Which spawnd the account lives on.
 *
 * Most people sign in to spawnd.dev and never see the second tab. The one who
 * runs their own server picks it here, in the flow, rather than finding the
 * setting after signing in to the wrong place — which is where it used to be.
 *
 * A hook rather than a component because its two pieces live in two places on
 * the sheet: the tabs above the lockup, the address under the title.
 */
export function useServerPicker({ swipe }: ServerPickerOptions = {}): ServerPicker {
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState<ServerChoice>("spawnd");
  const [overridden, setOverridden] = useState(false);
  const [value, setValue] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [probe, setProbe] = useState<Probe>({ status: "idle" });

  useEffect(() => {
    let active = true;
    void getBaseUrlResolution().then(
      (resolution) => {
        if (!active || resolution.source !== "runtime override") return;
        setChoice("custom");
        setOverridden(true);
        setValue(resolution.url);
        setProbe({ status: "connected", url: resolution.url });
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);

  const ready = choice === "spawnd" || probe.status === "connected";

  const chooseDefault = useCallback(async () => {
    setChoice("spawnd");
    if (!overridden) return;
    setOverridden(false);
    setProbe({ status: "idle" });
    await setBaseUrl(null);
    await queryClient.resetQueries();
  }, [overridden, queryClient]);

  const choose = useCallback(
    (next: ServerChoice) => {
      if (next === "spawnd") void chooseDefault();
      else setChoice("custom");
    },
    [chooseDefault],
  );

  const step = useCallback(
    (delta: -1 | 1) => {
      const index = SERVER_CHOICES.findIndex((option) => option.value === choice);
      const next = SERVER_CHOICES[index + delta];
      if (next !== undefined && next.value !== choice) {
        haptics.selection();
        choose(next.value);
      }
    },
    [choice, choose],
  );

  const connect = async () => {
    let normalized: string;
    try {
      normalized = normalizeServerUrl(value);
      setValidationError(null);
    } catch (error) {
      setValidationError(errorMessage(error));
      return;
    }
    setProbe({ status: "testing" });
    try {
      await testServerConnection(normalized);
      await setBaseUrl(normalized);
      setValue(normalized);
      setOverridden(true);
      setProbe({ status: "connected", url: normalized });
      // The sign-in options come from the server, so they are asked for again.
      await queryClient.resetQueries();
      haptics.success();
    } catch (error) {
      setProbe({ status: "failed", message: errorMessage(error) });
      haptics.error();
    }
  };

  const connected = probe.status === "connected" && probe.url === value.trim();

  const tabs = (
    <View testID="login-server">
      <UnderlineTabs
        accessibilityLabel="Server"
        {...(swipe === undefined ? {} : { swipe })}
        onChange={choose}
        options={SERVER_CHOICES}
        testID="login-server-choice"
        value={choice}
      />
    </View>
  );

  const field =
    choice === "custom" ? (
      <View style={styles.custom}>
        <Field
          error={validationError}
          hint="Where your own spawnd runs. HTTPS unless you type http:// yourself."
          label="Server URL"
          variant="auth"
        >
          <Input
            editable={probe.status !== "testing"}
            error={validationError !== null}
            onChangeText={(next) => {
              setValue(next);
              setValidationError(null);
              if (probe.status !== "idle") setProbe({ status: "idle" });
            }}
            onSubmitEditing={() => {
              void connect();
            }}
            placeholder="https://spawn.example.com"
            purpose="url"
            returnKeyType="go"
            testID="login-server-url"
            value={value}
          />
        </Field>
        {probe.status === "connected" ? (
          <Text accessibilityLiveRegion="polite" color="success" variant="caption">
            Signing in to {probe.url}.
          </Text>
        ) : null}
        {probe.status === "failed" ? (
          <Text accessibilityRole="alert" color="destructive" variant="caption">
            Connection failed: {probe.message}
          </Text>
        ) : null}
        {connected ? null : (
          <AuthAction
            label={probe.status === "testing" ? "Connecting…" : "Use this server"}
            loading={probe.status === "testing"}
            onPress={() => {
              void connect();
            }}
            testID="login-server-connect"
            tone="quiet"
          />
        )}
      </View>
    ) : null;

  return { tabs, field, ready, choice, step };
}

const styles = StyleSheet.create({
  custom: {
    gap: spacing[3],
  },
});
