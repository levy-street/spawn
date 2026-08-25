import { useIsFocused } from "@react-navigation/native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
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
import { SetupChecklist } from "@/components/onboarding/setup-checklist";
import { TrustFailureState } from "@/components/onboarding/trust-failure-state";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { getBaseUrl } from "@/data/api/config";
import type { BrowserEndorsementRecord } from "@/data/api/schemas/trust";
import { useHostsQuery } from "@/data/queries/hosts";
import {
  acceptPairingEndorsement,
  approvePendingPairing,
  lookupPendingPairing,
  type PairingApprovalResult,
  type PairingFailure,
  type PendingPairingCeremony,
  pairingFailureForProtocolError,
  serverOriginFromBaseUrl,
  toPairingFailure,
  useAccountDevices,
  usePendingEndorsements,
  useRegisteredPhone,
} from "@/data/queries/pairing";
import { useCreateSetupClaimMutation, useSetupClaimQuery } from "@/data/queries/setup";
import { qk } from "@/data/queryKeys";
import { formatHostFingerprint } from "@/data/trust/host-pins";
import { haptics } from "@/lib/haptics";
import { spacing } from "@/theme";

type HostStage = "instructions" | "code" | "review" | "failure" | "success";
type ReviewSource = "typed" | "claim" | "link";
type PairingLookupRequest =
  | { source: "typed"; userCode: string }
  | { source: "claim"; approvalRef: string }
  | { source: "link"; approvalRef: string; linkHostKey?: string };

export const INLINE_APPROVE_LEAD =
  "Fastest: open the link in the machine's terminal — it verifies the identity automatically. Or compare the fingerprint below against the terminal.";

export interface HostPairingStepProps {
  accountId: string;
  initialApprovalRef?: string;
  initialHostKey?: string;
  initialLinkMalformed?: boolean;
  onExit?: () => void;
  onSkip?: () => void;
}

export function HostPairingStep({
  accountId,
  initialApprovalRef,
  initialHostKey,
  initialLinkMalformed = false,
  onExit,
  onSkip,
}: HostPairingStepProps) {
  const queryClient = useQueryClient();
  const focused = useIsFocused();
  const phoneQuery = useRegisteredPhone(accountId);
  const devicesQuery = useAccountDevices(phoneQuery.isSuccess);
  const endorsementsQuery = usePendingEndorsements(accountId, phoneQuery.data?.id ?? null);
  const hostsQuery = useHostsQuery();
  const createClaim = useCreateSetupClaimMutation();
  const [stage, setStage] = useState<HostStage>("instructions");
  const [appActive, setAppActive] = useState(
    AppState.currentState !== "background" && AppState.currentState !== "inactive",
  );
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [serverOrigin, setServerOrigin] = useState<string | null>(null);
  const [claimToken, setClaimToken] = useState<string | null>(null);
  const [commandCopied, setCommandCopied] = useState(false);
  const [ceremony, setCeremony] = useState<PendingPairingCeremony | null>(null);
  const [failure, setFailure] = useState<PairingFailure | null>(null);
  const [reviewSource, setReviewSource] = useState<ReviewSource>("typed");
  const [allowRevokedPin, setAllowRevokedPin] = useState(false);
  const [success, setSuccess] = useState<{
    result: PairingApprovalResult;
    requiresPhoneComparison: boolean;
  } | null>(null);
  const claimMintStarted = useRef(false);
  const claimLookupRef = useRef<string | null>(null);
  const initialLookupStarted = useRef(false);
  const claimQuery = useSetupClaimQuery(claimToken, focused && appActive);
  const installCommand =
    baseUrl === null
      ? DEFAULT_INSTALL_COMMAND
      : installCommandForBaseUrl(baseUrl, claimToken ?? undefined);
  const createClaimMutate = createClaim.mutate;
  const createClaimReset = createClaim.reset;

  const beginSetupClaim = useCallback(() => {
    claimMintStarted.current = true;
    claimLookupRef.current = null;
    setClaimToken(null);
    setCommandCopied(false);
    createClaimReset();
    createClaimMutate(undefined, {
      onSuccess: (claim) => setClaimToken(claim.token),
      // A server without Phase C returns 404/405. Network and older-server
      // failures also keep the established bare-command + typed-code path
      // usable instead of making setup depend on this additive helper.
      onError: () => setClaimToken(null),
    });
  }, [createClaimMutate, createClaimReset]);

  useEffect(() => {
    let active = true;
    void getBaseUrl()
      .then((baseUrl) => {
        if (!active) return;
        setBaseUrl(baseUrl);
        setServerOrigin(serverOriginFromBaseUrl(baseUrl));
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

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setAppActive(state === "active");
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (baseUrl === null || initialApprovalRef !== undefined || claimMintStarted.current) {
      return;
    }
    beginSetupClaim();
  }, [baseUrl, beginSetupClaim, initialApprovalRef]);

  const lookupMutation = useMutation({
    mutationFn: (request: PairingLookupRequest) => {
      if (serverOrigin === null) throw new Error("Server address is not ready");
      setReviewSource(request.source);
      return lookupPendingPairing({
        accountId,
        serverOrigin,
        ...(request.source === "typed"
          ? { userCode: request.userCode }
          : { approvalRef: request.approvalRef }),
        ...(request.source === "link" && request.linkHostKey !== undefined
          ? { linkHostKey: request.linkHostKey }
          : {}),
      });
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
  const lookupMutate = lookupMutation.mutate;

  useEffect(() => {
    if (initialLookupStarted.current || serverOrigin === null) return;
    if (initialLinkMalformed) {
      initialLookupStarted.current = true;
      setFailure({ kind: "link-identity-malformed" });
      setStage("failure");
      return;
    }
    if (initialApprovalRef === undefined) return;
    initialLookupStarted.current = true;
    lookupMutate({
      source: "link",
      approvalRef: initialApprovalRef,
      ...(initialHostKey === undefined ? {} : { linkHostKey: initialHostKey }),
    });
  }, [initialApprovalRef, initialHostKey, initialLinkMalformed, lookupMutate, serverOrigin]);

  const claim = claimQuery.data ?? null;
  useEffect(() => {
    if (!focused || !appActive) return;
    if (claim?.status === "failed") {
      if (claim.error !== null) setFailure(pairingFailureForProtocolError(claim.error));
      else setFailure({ kind: "pairing-rejected" });
      setStage("failure");
      return;
    }
    if (
      claim?.status !== "ready" ||
      claim.approval_ref === null ||
      claimLookupRef.current === claim.approval_ref
    ) {
      return;
    }
    claimLookupRef.current = claim.approval_ref;
    lookupMutate({ source: "claim", approvalRef: claim.approval_ref });
  }, [appActive, claim, focused, lookupMutate]);

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
      setSuccess({
        result,
        requiresPhoneComparison: ceremony?.linkVerifiedHostKey === null,
      });
      setStage("success");
      void setHostSkipped(false);
      void queryClient.invalidateQueries({ queryKey: qk.hosts() });
      void queryClient.invalidateQueries({ queryKey: qk.trustLocalPins(accountId) });
      if (claimToken !== null) {
        void queryClient.invalidateQueries({ queryKey: qk.setupClaim(claimToken) });
      }
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
        onAction={() => {
          // Reset before refetching. A query that has already failed keeps its
          // error, and `retry: false` means nothing re-runs on its own — so a
          // bare refetch can leave the same message on screen with no request
          // ever leaving the device, which is exactly how this button came to
          // look broken.
          queryClient.resetQueries({ queryKey: qk.browserDeviceRegistration(accountId) });
          void phoneQuery.refetch();
        }}
        {...(onSkip === undefined ? {} : { onSkip })}
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
  const setupChecklist =
    claimToken === null ? null : (
      <SetupChecklist
        claim={claim}
        commandCopied={commandCopied}
        hosts={hostsQuery.data ?? []}
        onEnterCode={() => setStage("code")}
        {...(onExit === undefined && onSkip === undefined ? {} : { onExit: onExit ?? onSkip })}
      />
    );

  if (stage === "instructions") {
    return (
      <View style={styles.hostStep}>
        <InstallInstructions
          command={installCommand}
          onCommandCopied={() => setCommandCopied(true)}
          onContinue={() => setStage("code")}
          preparing={createClaim.isPending}
          {...(onSkip === undefined ? {} : { onSkip })}
        />
        {setupChecklist}
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
      <View style={styles.hostStep}>
        {setupChecklist}
        <PairingCodeEntry
          busy={lookupMutation.isPending || serverOrigin === null}
          error={
            lookupMutation.isError ? (toPairingFailure(lookupMutation.error).detail ?? null) : null
          }
          onBack={() => setStage("instructions")}
          onSubmit={(code) => lookupMutation.mutate({ source: "typed", userCode: code })}
        />
      </View>
    );
  }

  if (stage === "review" && ceremony !== null) {
    return (
      <View style={styles.hostStep}>
        {setupChecklist}
        <FingerprintReview
          approving={approveMutation.isPending}
          ceremony={ceremony}
          {...(reviewSource === "claim" ? { lead: INLINE_APPROVE_LEAD } : {})}
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
      </View>
    );
  }

  if (stage === "success" && success !== null) {
    const pairAnother = () => {
      setCeremony(null);
      setSuccess(null);
      setStage("instructions");
      claimMintStarted.current = false;
      beginSetupClaim();
    };
    if (success.requiresPhoneComparison) {
      return (
        <View style={styles.hostStep}>
          {setupChecklist}
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
        </View>
      );
    }
    return (
      <View style={styles.hostStep}>
        {setupChecklist}
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
      </View>
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
