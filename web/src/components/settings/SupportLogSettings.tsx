"use client";

import { Component, type PropsWithChildren, useSyncExternalStore } from "react";
import { SwitchRow } from "@/components/ui/switch";
import { useSupportLog } from "@/hooks/useSupportLog";
import { collectionLine } from "@/lib/support-log";
import copy from "@/lib/support-log-copy.json";

function subscribeVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

class SupportLogBoundary extends Component<PropsWithChildren> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function SupportLogSettings({ accountId }: { accountId: string }) {
  return (
    <SupportLogBoundary>
      <SupportLogPanel accountId={accountId} />
    </SupportLogBoundary>
  );
}

function SupportLogPanel({ accountId }: { accountId: string }) {
  const visible = useSyncExternalStore(
    subscribeVisibility,
    () => !document.hidden,
    () => false,
  );
  return visible ? <VisibleSupportLog accountId={accountId} /> : null;
}

function VisibleSupportLog({ accountId }: { accountId: string }) {
  const { state, hasIdentity, change, busy, message } = useSupportLog(accountId);
  if (!state) return null;
  return (
    <section
      aria-label={copy.title}
      className="space-y-3 rounded-md border border-border p-3 text-sm"
    >
      <h3 className="font-medium">{copy.title}</h3>
      <SwitchRow
        label={copy.switchLabel}
        hint={copy.description}
        checked={state.sharing === "on"}
        onCheckedChange={change}
        disabled={busy || hasIdentity !== true}
      />
      {hasIdentity === false && <p>{copy.cannotSign}</p>}
      {state.sharing === "off_signer_removed" && <p>{copy.offSignerRemoved}</p>}
      {message && <p role="status">{message}</p>}
      {state.hosts
        .filter((host) => !host.capable)
        .map((host) => (
          <p key={host.id}>{copy.needsUpdate.replace("{machine}", () => host.name)}</p>
        ))}
      <h4 className="font-medium">{copy.collected}</h4>
      {state.collections.length === 0 ? (
        <p>{copy.empty}</p>
      ) : (
        <ul className="space-y-2">
          {state.collections.map((row) => (
            <li key={row.id}>
              <p>{collectionLine(row)}</p>
              <p className="text-muted-foreground">
                {copy.reason.replace("{reason}", () => row.reason)}
              </p>
            </li>
          ))}
        </ul>
      )}
      {!state.collections.some(
        (row) => row.state === "declined" && row.decline_code === "signer_untrusted",
      ) && <p className="text-muted-foreground">{copy.help}</p>}
    </section>
  );
}
