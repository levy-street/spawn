import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { EndorsementOption } from "@/components/onboarding/endorsement-option";
import { FingerprintReview } from "@/components/onboarding/fingerprint-review";
import {
  DEFAULT_INSTALL_COMMAND,
  InstallInstructions,
  installCommandForBaseUrl,
} from "@/components/onboarding/install-instructions";
import { setHostSkipped } from "@/components/onboarding/onboarding-state";
import { PairingCodeEntry } from "@/components/onboarding/pairing-code-entry";
import { PairingSuccess } from "@/components/onboarding/pairing-success";
import { TrustFailureState } from "@/components/onboarding/trust-failure-state";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { getBaseUrl } from "@/data/api/config";
import type { BrowserEndorsementRecord } from "@/data/api/schemas/trust";
import {
  acceptPairingEndorsement,
  approvePendingPairing,
  lookupPendingPairing,
  type PairingApprovalResult,
  type PairingFailure,
  type PendingPairingCeremony,
  serverOriginFromBaseUrl,
  toPairingFailure,
  useAccountDevices,
  usePendingEndorsements,
  useRegisteredPhone,
} from "@/data/queries/pairing";
import { qk } from "@/data/queryKeys";
import { formatHostFingerprint } from "@/data/trust/host-pins";
import { haptics } from "@/lib/haptics";
import { spacing } from "@/theme";

type HostStage = "instructions" | "code" | "review" | "failure" | "success";

export interface HostPairingStepProps {
  accountId: string;
  onSkip?: () => void;
}

export function HostPairingStep({ accountId, onSkip }: HostPairingStepProps) {
  const queryClient = useQueryClient();
  const phoneQuery = useRegisteredPhone(accountId);
  const devicesQuery = useAccountDevices(phoneQuery.isSuccess);
  const endorsementsQuery = usePendingEndorsements(accountId, phoneQuery.data?.id ?? null);
  const [stage, setStage] = useState<HostStage>("instructions");
  const [serverOrigin, setServerOrigin] = useState<string | null>(null);
  const [installCommand, setInstallCommand] = useState(DEFAULT_INSTALL_COMMAND);
  const [ceremony, setCeremony] = useState<PendingPairingCeremony | null>(null);
  const [failure, setFailure] = useState<PairingFailure | null>(null);
  const [allowRevokedPin, setAllowRevokedPin] = useState(false);
  const [success, setSuccess] = useState<{
    result: PairingApprovalResult;
    requiresPhoneComparison: boolean;
  } | null>(null);

  useEffect(() => {
    let active = true;
    void getBaseUrl()
      .then((baseUrl) => {
        if (!active) return;
        setServerOrigin(serverOriginFromBaseUrl(baseUrl));
        setInstallCommand(installCommandForBaseUrl(baseUrl));
      })
      .catch((error: unknown) => {
        if (!active) return;
        setFailure(toPairingFailure(error));
        setStage("failure");
      });
    return () => {
      active = false;
    };
  }, []);

  const lookupMutation = useMutation({
    mutationFn: (code: string) => {
      if (serverOrigin === null) throw new Error("Server address is not ready");
      return lookupPendingPairing({ userCode: code, accountId, serverOrigin });
    },
    onSuccess: (nextCeremony) => {
      setCeremony(nextCeremony);
      if (nextCeremony.pinState === "revoked") {
        setFailure({ kind: "pin-revoked" });
        setStage("failure");
      } else {
        setAllowRevokedPin(false);
        setStage("review");
      }
    },
    onError: (error) => {
      setFailure(toPairingFailure(error));
      setStage("failure");
    },
  });

  const approveMutation = useMutation({
    mutationFn: () => {
      if (ceremony === null || phoneQuery.data === undefined) {
        throw new Error("Pairing review is not ready");
      }
      return approvePendingPairing({
        ceremony,
        phone: phoneQuery.data,
        allowRevokedPin,
      });
    },
    onSuccess: (result) => {
      setSuccess({ result, requiresPhoneComparison: true });
      setStage("success");
      void setHostSkipped(false);
      void queryClient.invalidateQueries({ queryKey: qk.hosts() });
      void queryClient.invalidateQueries({ queryKey: qk.trustLocalPins(accountId) });
    },
    onError: (error) => {
      setFailure(toPairingFailure(error));
      setStage("failure");
    },
  });

  const endorsementMutation = useMutation({
    mutationFn: (input: { record: BrowserEndorsementRecord; endorserFingerprint: string }) => {
      if (serverOrigin === null || phoneQuery.data === undefined) {
        throw new Error("Device endorsement is not ready");
      }
      return acceptPairingEndorsement({
        accountId,
        serverOrigin,
        phone: phoneQuery.data,
        record: input.record,
        expectedEndorserFingerprint: input.endorserFingerprint,
      });
    },
    onSuccess: (pin, variables) => {
      haptics.success();
      setSuccess({
        result: {
          hostId: pin.hostIds[0] ?? null,
          hostName: variables.record.host_name,
          hostPublicKey: pin.hostPublicKey,
        },
        requiresPhoneComparison: false,
      });
      setStage("success");
      void queryClient.invalidateQueries({ queryKey: qk.hosts() });
      void queryClient.invalidateQueries({ queryKey: qk.trustLocalPins(accountId) });
    },
    onError: (error) => {
      setFailure(toPairingFailure(error));
      setStage("failure");
    },
  });

  if (phoneQuery.isPending) {
    return (
      <View style={styles.loadingState}>
        <Spinner label="Preparing device trust" />
        <Text color="mutedForeground">Preparing device trust…</Text>
      </View>
    );
  }
  if (phoneQuery.isError) {
    return (
      <TrustFailureState
        failure={toPairingFailure(phoneQuery.error)}
        onAction={() => void phoneQuery.refetch()}
      />
    );
  }

  const otherDeviceCount =
    devicesQuery.data?.filter(
      (device) => device.id !== phoneQuery.data.id && device.revoked_at === null,
    ).length ?? 0;
  const pendingEndorsements = endorsementsQuery.data ?? [];
  const acceptingKey = endorsementMutation.variables
    ? `${endorsementMutation.variables.record.host_id}:${endorsementMutation.variables.record.endorser_device_id}`
    : null;

  if (stage === "instructions") {
    return (
      <View style={styles.hostStep}>
        <InstallInstructions
          command={installCommand}
          onContinue={() => setStage("code")}
          {...(onSkip === undefined ? {} : { onSkip })}
        />
        <EndorsementOption
          acceptingKey={acceptingKey}
          onAccept={(record, endorserFingerprint) =>
            endorsementMutation.mutate({ record, endorserFingerprint })
          }
          onRefresh={() => void endorsementsQuery.refetch()}
          otherDeviceCount={otherDeviceCount}
          pending={pendingEndorsements}
          phone={phoneQuery.data}
          refreshing={endorsementsQuery.isFetching}
        />
      </View>
    );
  }

  if (stage === "code") {
    return (
      <PairingCodeEntry
        busy={lookupMutation.isPending || serverOrigin === null}
        error={
          lookupMutation.isError ? (toPairingFailure(lookupMutation.error).detail ?? null) : null
        }
        onBack={() => setStage("instructions")}
        onSubmit={(code) => lookupMutation.mutate(code)}
      />
    );
  }

  if (stage === "review" && ceremony !== null) {
    return (
      <FingerprintReview
        approving={approveMutation.isPending}
        ceremony={ceremony}
        onApprove={() => approveMutation.mutate()}
        onBack={() => setStage("code")}
        onExpired={() => {
          setFailure({ kind: "pairing-expired" });
          setStage("failure");
        }}
        onMismatch={() => {
          haptics.error();
          setFailure({ kind: "fingerprint-mismatch" });
          setStage("failure");
        }}
        phoneFingerprint={formatHostFingerprint(phoneQuery.data.public_key)}
        reapprovingRevokedPin={allowRevokedPin}
      />
    );
  }

  if (stage === "success" && success !== null) {
    const pairAnother = () => {
      setCeremony(null);
      setSuccess(null);
      setStage("instructions");
    };
    if (success.requiresPhoneComparison) {
      return (
        <PairingSuccess
          hostName={success.result.hostName}
          onConfirmed={() => haptics.success()}
          onMismatch={() => {
            haptics.error();
            setFailure({ kind: "fingerprint-mismatch" });
            setStage("failure");
          }}
          onPairAnother={pairAnother}
          phoneFingerprint={formatHostFingerprint(phoneQuery.data.public_key)}
        />
      );
    }
    return (
      <EmptyState
        action={
          <Button onPress={pairAnother} variant="outline">
            Connect another host
          </Button>
        }
        description={`${success.result.hostName} is connected. It will appear as soon as its daemon comes online.`}
        icon="ShieldCheck"
        title="Host approved"
      />
    );
  }

  const activeFailure = failure ?? { kind: "pairing-rejected" as const };
  return (
    <TrustFailureState
      failure={activeFailure}
      onAction={() => {
        if (activeFailure.kind === "pin-revoked" && ceremony !== null) {
          setAllowRevokedPin(true);
          setStage("review");
          return;
        }
        if (activeFailure.kind === "approval-incomplete" && ceremony !== null) {
          setAllowRevokedPin(true);
          approveMutation.mutate();
          return;
        }
        if (activeFailure.kind === "endorsement-invalid") {
          void endorsementsQuery.refetch();
          setStage("instructions");
          return;
        }
        setStage("code");
      }}
      {...(ceremony === null ? {} : { onRestart: () => setStage("code") })}
    />
  );
}

const styles = StyleSheet.create({
  hostStep: {
    gap: spacing[8],
  },
  loadingState: {
    alignItems: "center",
    gap: spacing[3],
    paddingVertical: spacing[12],
  },
});
