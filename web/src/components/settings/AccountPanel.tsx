"use client";

import { Button } from "@/components/ui/button";
import { logout, useAuth } from "@/lib/auth";

export function AccountPanel() {
  const { user } = useAuth();
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Account</h2>
        <p className="text-sm text-muted-foreground">Signed in as {user?.email ?? "—"}</p>
      </div>
      <Button
        variant="secondary"
        onClick={() => {
          void logout();
        }}
      >
        Log out
      </Button>
      <p className="text-xs text-muted-foreground">Account deletion is not yet wired up.</p>
    </section>
  );
}
