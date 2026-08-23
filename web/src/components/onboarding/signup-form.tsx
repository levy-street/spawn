import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, type AuthConfig, auth, type User } from "@/lib/api";
import { OAuthButtons } from "./oauth-buttons";

interface SignupFormProps {
  config: AuthConfig;
  initialInvite?: string | null;
  oauthReturnTo: string;
  onSuccess: (user: User) => void;
  submitLabel?: string;
}

export function SignupForm({
  config,
  initialInvite = null,
  oauthReturnTo,
  onSuccess,
  submitLabel = "Create account",
}: SignupFormProps) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState(initialInvite ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await auth.signup({
        email,
        password,
        invite: invite.trim() === "" ? null : invite.trim(),
      });
      queryClient.setQueryData(["me"], { user: result.user });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      onSuccess(result.user);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not create your account");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      <OAuthButtons providers={config.providers} returnTo={oauthReturnTo} />

      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="space-y-2">
          <Label htmlFor="signup-email">Email</Label>
          <Input
            id="signup-email"
            className="h-11"
            type="email"
            autoComplete="email"
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={submitting}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="signup-password">Password</Label>
          <Input
            id="signup-password"
            className="h-11"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
          />
          <p className="text-xs leading-5 text-muted-foreground">Use at least 8 characters.</p>
        </div>
        {config.invite_only ? (
          <div className="space-y-2">
            <Label htmlFor="signup-invite">Invite code</Label>
            <Input
              id="signup-invite"
              className="h-11 font-mono uppercase"
              autoComplete="off"
              required
              value={invite}
              onChange={(event) => setInvite(event.target.value)}
              disabled={submitting}
            />
          </div>
        ) : null}
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="h-11 w-full" disabled={submitting}>
          {submitting ? "Creating account…" : submitLabel}
        </Button>
      </form>
    </div>
  );
}
