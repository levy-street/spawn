import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Text } from "@/components/ui/text";
import type { PairingFailure, PairingFailureKind } from "@/data/queries/pairing";
import { spacing } from "@/theme";

interface FailureCopy {
  title: string;
  description: string;
  action: string;
}

export const FAILURE_COPY: Record<PairingFailureKind, FailureCopy> = {
  "fingerprint-mismatch": {
    title: "Fingerprints do not match",
    description:
      "Connection blocked. Recheck the code on the machine and explicitly review its fingerprint again.",
    action: "Enter a new code",
  },
  "identity-missing": {
    title: "Phone identity is missing",
    description: "Set up this phone in Device trust before approving a host.",
    action: "Try device setup again",
  },
  "identity-revoked": {
    title: "Phone identity was revoked",
    description: "This device cannot approve hosts. Start fresh from Device trust settings.",
    action: "Back to pairing",
  },
  "identity-storage-unavailable": {
    title: "Phone identity storage is unavailable",
    description: "Secure identity storage could not be read. Host approval is blocked.",
    action: "Try again",
  },
  "pin-revoked": {
    title: "This host identity was revoked",
    description:
      "Reapprove only after checking the host fingerprint against the value on the machine.",
    action: "Review this key again",
  },
  "pin-storage-unavailable": {
    title: "Trust storage is unavailable",
    description: "The host pin store could not be read. Host approval is blocked.",
    action: "Try again",
  },
  "pairing-expired": {
    title: "Pairing code expired",
    description: "That code expired. On the machine, run spawnd possess again.",
    action: "Enter a new code",
  },
  "pairing-denied": {
    title: "Approval was declined",
    description: "The approval was declined in the browser. Nothing was registered.",
    action: "Back to pairing",
  },
  "key-conflict": {
    title: "This machine belongs to another account",
    description: [
      "This machine was set up before, under a different SPAWN D account, and that account still holds its identity. Nothing was changed.",
      "• To use it under that account: sign in there and approve as usual.",
      "• To hand it to this account: remove the host from the old account's Hosts page first, then run spawnd possess again.",
      "• To keep both accounts on this machine: spawnd possess --new-account",
    ].join("\n"),
    action: "Back to pairing",
  },
  "pin-conflict": {
    title: "Earlier approval does not match",
    description:
      "The browser that approved this machine doesn't match its earlier approval. Approve again from a browser you've used with this host before — or remove the host on the web and start fresh.",
    action: "Back to pairing",
  },
  "pin-limit": {
    title: "Approval limit reached",
    description:
      "This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again.",
    action: "Back to pairing",
  },
  "link-identity-mismatch": {
    title: "This host could not be verified",
    description:
      "This host's identity could not be verified: the server presented a different identity key than the one in your host's link. Nothing was trusted and no access was granted. This can mean the connection is being tampered with — start over from the host's terminal, on a network you trust.",
    action: "Back to pairing",
  },
  "link-identity-malformed": {
    title: "This host could not be verified",
    description:
      "The identity check in this link (the part after '#') is damaged or cut off, so this host could not be verified. Nothing was trusted. Copy the entire link from the host's terminal and open it again.",
    action: "Back to pairing",
  },
  "unknown-code": {
    title: "Code not found",
    description: "Check the eight characters shown by spawnd possess and try again.",
    action: "Try another code",
  },
  "host-not-ready": {
    title: "Host proof is still pending",
    description: "Wait for spawnd possess to finish preparing the code, then retry.",
    action: "Retry lookup",
  },
  "approval-incomplete": {
    title: "Server approval did not complete",
    description:
      "The exact host fingerprint is saved locally, but server approval did not complete. Retry the same reviewed approval or enter a new code.",
    action: "Retry approval",
  },
  "endorsement-invalid": {
    title: "Endorsement could not be verified",
    description: "The trusted-device introduction was invalid or changed. No host key was saved.",
    action: "Refresh endorsements",
  },
  "pairing-rejected": {
    title: "Host approval was blocked",
    description: "The reviewed host could not be approved. Check the machine and try again.",
    action: "Try again",
  },
};

export interface TrustFailureStateProps {
  failure: PairingFailure;
  onAction: () => void;
  onRestart?: () => void;
  /**
   * A way past a step that will not complete.
   *
   * Connecting a machine is not a precondition for having an account, and a
   * failure here used to leave one button on screen and no route onward. Every
   * one of these failures can be resolved later from Settings.
   */
  onSkip?: () => void;
}

export function TrustFailureState({
  failure,
  onAction,
  onRestart,
  onSkip,
}: TrustFailureStateProps) {
  const copy = FAILURE_COPY[failure.kind];
  const description =
    failure.detail === undefined ? (
      copy.description
    ) : (
      <View style={styles.copy}>
        <Text color="mutedForeground" style={styles.centered}>
          {copy.description}
        </Text>
        <Text color="destructive" style={styles.centered} variant="caption">
          {failure.detail}
        </Text>
      </View>
    );

  return (
    <EmptyState
      action={
        <View style={styles.actions}>
          <Button onPress={onAction}>{copy.action}</Button>
          {onRestart !== undefined ? (
            <Button onPress={onRestart} variant="ghost">
              Enter a new code
            </Button>
          ) : null}
          {onSkip !== undefined ? (
            <Button onPress={onSkip} variant="ghost">
              Set this up later
            </Button>
          ) : null}
        </View>
      }
      description={description}
      icon="ShieldAlert"
      testID={`trust-failure-${failure.kind}`}
      title={copy.title}
    />
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: spacing[2],
    width: "100%",
  },
  centered: {
    textAlign: "center",
  },
  copy: {
    gap: spacing[2],
  },
});
