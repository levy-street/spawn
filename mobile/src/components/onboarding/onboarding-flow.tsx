import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { HostPairingStep } from "@/components/onboarding/host-pairing-step";
import { leaveOnboarding } from "@/components/onboarding/onboarding-navigation";
import {
  type OnboardingStep,
  readHostSkipped,
  resolveOnboardingStep,
  setHostSkipped,
} from "@/components/onboarding/onboarding-state";
import { DeviceApprovalBody } from "@/components/trust/device-approval-screen";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { getMe } from "@/data/api/endpoints/account";
import { getAuthConfig } from "@/data/api/endpoints/auth";
import { listHosts } from "@/data/api/endpoints/hosts";
import { useDeviceHostApprovals } from "@/data/queries/device-trust";
import { qk } from "@/data/queryKeys";
import { borderWidth, chrome, spacing, useTheme } from "@/theme";

function ProgressRail({
  current,
  verificationRequired,
}: {
  current: OnboardingStep;
  verificationRequired: boolean;
}) {
  const theme = useTheme();
  const steps: readonly OnboardingStep[] = verificationRequired
    ? ["account", "verify", "host", "done"]
    : ["account", "host", "done"];
  const labels: Record<OnboardingStep, string> = {
    account: "Account",
    verify: "Verify",
    host: "Host",
    done: "Done",
  };
  const currentIndex = steps.indexOf(current);

  return (
    <View accessibilityRole="progressbar" style={styles.rail}>
      {steps.map((step, index) => {
        const active = index === currentIndex;
        const complete = index < currentIndex;
        return (
          <View key={step} style={styles.railStep}>
            <View
              style={[
                styles.railMarker,
                {
                  backgroundColor:
                    active || complete ? theme.colors.foreground : theme.colors.background,
                  borderColor: active || complete ? theme.colors.foreground : theme.colors.border,
                  borderRadius: theme.radii.pill,
                },
              ]}
            />
            <Text color={active ? "foreground" : "mutedForeground"} variant="caption">
              {labels[step]}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function OnboardingFlow(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const meQuery = useQuery({ queryKey: qk.me(), queryFn: getMe });
  const configQuery = useQuery({ queryKey: qk.authConfig(), queryFn: getAuthConfig });
  const hostsQuery = useQuery({ queryKey: qk.hosts(), queryFn: listHosts, refetchInterval: 3000 });
  const hostIds = (hostsQuery.data ?? []).map((host) => host.id);
  // Which of those hosts will actually answer this device. Polls live so an
  // approval made on a laptop finishes setup without restarting it here.
  const approvals = useDeviceHostApprovals(true);
  const [hostSkipped, setHostSkippedState] = useState<boolean | null>(null);

  useEffect(() => {
    void readHostSkipped().then(setHostSkippedState);
  }, []);

  const loading =
    meQuery.isPending || configQuery.isPending || hostsQuery.isPending || hostSkipped === null;
  const errorTitle = meQuery.isError
    ? "Couldn’t load your account"
    : configQuery.isError
      ? "Couldn’t load sign-in options"
      : hostsQuery.isError
        ? "Couldn’t load your hosts"
        : null;
  const step = resolveOnboardingStep({
    account: meQuery.data ? { emailVerified: meQuery.data.user.email_verified_at !== null } : null,
    emailVerificationRequired: configQuery.data?.email_verification_required ?? false,
    hostCount: hostsQuery.data?.length ?? 0,
    // Unknown trust must not gate setup, so an unresolved probe counts as the
    // optimistic case and the terminal's own preflight catches the rest.
    deviceTrustedHostCount: approvals.resolved ? approvals.approved.length : hostIds.length,
    hostSkipped: hostSkipped ?? false,
  });

  let content: React.ReactNode;
  if (loading) {
    content = (
      <View style={styles.loadingState}>
        <Spinner label="Loading onboarding" />
        <Text color="mutedForeground">Loading setup…</Text>
      </View>
    );
  } else if (errorTitle !== null) {
    content = (
      <EmptyState
        action={
          <Button
            onPress={() => {
              void meQuery.refetch();
              void configQuery.refetch();
              void hostsQuery.refetch();
            }}
          >
            Try again
          </Button>
        }
        description="Check your connection, then try again."
        icon="AlertCircle"
        title={errorTitle}
      />
    );
  } else if (step === "verify") {
    content = (
      <EmptyState
        action={<Button onPress={() => void meQuery.refetch()}>Refresh</Button>}
        description="Confirm this address before connecting a machine."
        icon="Mail"
        title="Check your inbox"
      />
    );
  } else if (step === "done") {
    content = (
      <EmptyState
        action={
          hostsQuery.data?.length === 0 ? (
            <Button
              onPress={() => {
                void setHostSkipped(false).then(() => setHostSkippedState(false));
              }}
              variant="outline"
            >
              Connect a host
            </Button>
          ) : undefined
        }
        description={
          hostsQuery.data?.length === 0
            ? "Connect a host whenever you’re ready to open your first shell."
            : "Your hosts are ready."
        }
        icon="CheckCircle2"
        title="Setup complete"
      />
    );
  } else if (step === "host" && meQuery.data !== undefined) {
    // Two different problems wear the same step. With no host at all, the work
    // is installing spawnd and pairing it. With hosts the account already owns,
    // the work is getting THIS device admitted to them — a different ceremony
    // with a different first move, and the one a phone added to an existing
    // account always lands on.
    content =
      hostIds.length > 0 ? (
        <DeviceApprovalBody />
      ) : (
        <HostPairingStep
          accountId={meQuery.data.user.id}
          onSkip={() => {
            void setHostSkipped(true).then(() => setHostSkippedState(true));
          }}
        />
      );
  } else {
    content = (
      <EmptyState
        description="Sign in or create your account to continue setup."
        icon="UserRound"
        title="Create your account"
      />
    );
  }

  return (
    <View
      style={[styles.screen, { backgroundColor: theme.colors.background }]}
      testID="onboarding-flow"
    >
      <Screen
        header={<AppHeader onBack={() => leaveOnboarding(router)} title="Set up Spawn" />}
        padded={false}
        scroll
      >
        <View style={styles.content}>
          <ProgressRail
            current={step}
            verificationRequired={configQuery.data?.email_verification_required ?? false}
          />
          {content}
        </View>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    alignSelf: "center",
    gap: spacing[8],
    maxWidth: chrome.pickerPreferredWidth,
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[8],
    width: "100%",
  },
  loadingState: {
    alignItems: "center",
    gap: spacing[3],
    paddingVertical: spacing[12],
  },
  rail: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  railMarker: {
    borderWidth: borderWidth.hairline,
    height: spacing[2],
    width: spacing[2],
  },
  railStep: {
    alignItems: "center",
    gap: spacing[1],
  },
  screen: {
    flex: 1,
  },
});
