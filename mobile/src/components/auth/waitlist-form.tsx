import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { AuthAction } from "@/components/auth/auth-actions";
import { AuthField, authFormGap } from "@/components/auth/auth-field";
import { AuthMessage } from "@/components/auth/auth-message";
import { AuthBlock } from "@/components/auth/auth-shell";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/data/api/client";
import { useJoinWaitlistMutation } from "@/data/queries/auth";
import { validateEmail, validateRequired } from "@/lib/validation";

/**
 * The words the waitlist speaks, shared with the browser app to the letter:
 * a person who leaves an address on the site and later opens the app must
 * meet the same sentence.
 */
export const waitlistCopy = {
  title: "Join the waitlist",
  body: "SPAWN D is invite-only right now. Leave your email and we’ll send an invite when there’s room.",
  submit: "Join the waitlist",
  pending: "Joining…",
  doneTitle: "You’re on the list.",
  done: (email: string) => `We’ll email ${email} when there’s room.`,
  failed: "Could not join the waitlist. Try again in a moment.",
  throttled: "Too many tries from this network. Try again later.",
  haveInvite: "Have an invite code?",
  backToWaitlist: "Back to the waitlist",
} as const;

export function validateWaitlistEmail(email: string): string | null {
  return validateRequired(email) ?? validateEmail(email);
}

/** The one failure a person can act on is the cap; everything else is "try again". */
export function waitlistFailureMessage(error: unknown): string {
  return error instanceof ApiError && error.status === 429
    ? waitlistCopy.throttled
    : waitlistCopy.failed;
}

export interface WaitlistFormProps {
  /** Where the address was left — `signup` here; the site sends its page path. */
  source: string;
  onJoined: (email: string) => void;
}

/**
 * The address field and its slab, on the account sheet. The screen owns what
 * happens after: the title changes, and this form is gone.
 */
export function WaitlistForm({ source, onJoined }: WaitlistFormProps) {
  const join = useJoinWaitlistMutation();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const submit = async () => {
    const nextError = validateWaitlistEmail(email);
    setError(nextError);
    setRequestError(null);
    if (nextError !== null) return;
    const address = email.trim();
    try {
      await join.mutateAsync({ email: address, source });
      onJoined(address);
    } catch (cause) {
      setRequestError(waitlistFailureMessage(cause));
    }
  };

  return (
    <>
      <View style={styles.form}>
        <AuthField error={error} label="Email" required>
          <Input
            editable={!join.isPending}
            error={error !== null}
            onChangeText={(value) => {
              setEmail(value);
              setRequestError(null);
            }}
            onSubmitEditing={() => {
              void submit();
            }}
            placeholder="you@example.com"
            purpose="email"
            returnKeyType="go"
            testID="waitlist-email"
            value={email}
          />
        </AuthField>
      </View>
      {requestError !== null ? <AuthMessage tone="error">{requestError}</AuthMessage> : null}
      <AuthBlock>
        <AuthAction
          label={join.isPending ? waitlistCopy.pending : waitlistCopy.submit}
          loading={join.isPending}
          onPress={() => {
            void submit();
          }}
          testID="waitlist-submit"
        />
      </AuthBlock>
    </>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: authFormGap,
  },
});
