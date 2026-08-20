"use client";

/**
 * Trust UX demo — renders every component of web/src/trust-ux in every state
 * it defines (see web/src/trust-ux/DESIGN.md), with hardcoded mock data and
 * console.log callbacks. Scroll one page, see the whole designed system.
 */

import type { ReactNode } from "react";
import { ConnectionGate, VerifiedChip } from "@/trust-ux/ConnectionGate";
import { DeviceRoster } from "@/trust-ux/DeviceRoster";
import { HostTrustList } from "@/trust-ux/HostTrustList";
import { LinkDeviceApprove } from "@/trust-ux/LinkDeviceApprove";
import { LinkDeviceNew } from "@/trust-ux/LinkDeviceNew";
import { PairHost } from "@/trust-ux/PairHost";
import { PasskeyOnboarding } from "@/trust-ux/PasskeyOnboarding";
import { RecoveryFlow } from "@/trust-ux/RecoveryFlow";
import { RemoveDeviceDialog } from "@/trust-ux/RemoveDeviceDialog";
import { ResetPasskeyTrustDialog } from "@/trust-ux/ResetPasskeyTrustDialog";
import { SecurityOverview } from "@/trust-ux/SecurityOverview";
import { TrustHistory } from "@/trust-ux/TrustHistory";
import type {
  LinkDeviceApproveState,
  LinkDeviceNewState,
  PairHostState,
  PasskeyOnboardingState,
  RecoveryState,
  RequesterClaims,
  TrustDevice,
  TrustEvent,
  TrustHost,
} from "@/trust-ux/types";

function log(name: string) {
  return (...args: unknown[]) => console.log(`[trust-ux] ${name}`, ...args);
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-neutral-900">{title}</h2>
        {note ? <p className="mt-1 text-sm text-neutral-500">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Example({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 font-mono text-xs text-neutral-400">{label}</p>
      <div className="max-w-2xl">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mock data                                                           */
/* ------------------------------------------------------------------ */

const devicesPasskeyMode: TrustDevice[] = [
  {
    id: "d1",
    name: "Jeremy's MacBook Pro",
    platform: "macOS · Safari",
    isThisDevice: true,
    addedAt: "Mar 2",
    lastSeenAt: "now",
    provenance: { kind: "first-device" },
    backedByPasskey: true,
    soleKeyForHosts: [],
  },
  {
    id: "d2",
    name: "iPhone",
    platform: "iOS · Safari",
    isThisDevice: false,
    addedAt: "Mar 5",
    lastSeenAt: "2 hours ago",
    provenance: { kind: "linked", byDeviceName: "Jeremy's MacBook Pro", at: "Mar 5" },
    backedByPasskey: true,
    soleKeyForHosts: [],
  },
  {
    id: "d3",
    name: "Work ThinkPad",
    platform: "Linux · Firefox",
    isThisDevice: false,
    addedAt: "Aug 18",
    lastSeenAt: "yesterday",
    provenance: { kind: "linked", byDeviceName: "iPhone", at: "Aug 18" },
    backedByPasskey: false,
    vouchedForBy: { deviceId: "d2", deviceName: "iPhone" },
    soleKeyForHosts: ["atlas"],
  },
];

const devicesNoPasskeyMode: TrustDevice[] = [
  {
    id: "d1",
    name: "Framework laptop",
    platform: "Linux · Chromium",
    isThisDevice: true,
    addedAt: "Jan 12",
    lastSeenAt: "now",
    provenance: { kind: "first-device" },
    backedByPasskey: false,
    soleKeyForHosts: ["dream", "minivac"],
  },
  {
    id: "d2",
    name: "Pixel 9",
    platform: "Android · Chrome",
    isThisDevice: false,
    addedAt: "Feb 1",
    lastSeenAt: "3 days ago",
    provenance: { kind: "linked", byDeviceName: "Framework laptop", at: "Feb 1" },
    backedByPasskey: false,
    vouchedForBy: { deviceId: "d1", deviceName: "Framework laptop" },
    soleKeyForHosts: [],
  },
];

const hosts: TrustHost[] = [
  {
    id: "h1",
    name: "dream",
    online: true,
    status: { kind: "backed-by-passkey", alsoPairedWith: ["Jeremy's MacBook Pro"] },
  },
  {
    id: "h2",
    name: "atlas",
    online: false,
    status: { kind: "paired-only", deviceNames: ["Work ThinkPad"] },
    pendingRemovalApplies: true,
  },
  {
    id: "h3",
    name: "minivac",
    online: true,
    status: { kind: "orphaned", formerDeviceName: "old iPad" },
  },
];

const history: TrustEvent[] = [
  {
    id: "e1",
    at: "Aug 19, 14:02",
    kind: "device-removed",
    deviceName: "old iPad",
    byDeviceName: "Jeremy's MacBook Pro",
  },
  { id: "e2", at: "Aug 19, 13:58", kind: "link-mismatch-stopped" },
  {
    id: "e3",
    at: "Aug 18, 09:31",
    kind: "device-linked",
    deviceName: "Work ThinkPad",
    approvedBy: "iPhone",
  },
  { id: "e4", at: "Aug 12, 20:15", kind: "passkey-backed-host", hostName: "dream" },
  { id: "e5", at: "Aug 12, 20:15", kind: "passkey-backed-device", deviceName: "iPhone" },
  { id: "e6", at: "Aug 10, 11:47", kind: "account-restored", deviceName: "Jeremy's MacBook Pro" },
  { id: "e7", at: "Jul 30, 16:20", kind: "link-expired" },
  {
    id: "e8",
    at: "Jun 3, 10:05",
    kind: "host-paired",
    hostName: "atlas",
    byDeviceName: "Work ThinkPad",
  },
  { id: "e9", at: "Mar 2, 09:00", kind: "passkey-created" },
  { id: "e10", at: "Feb 28, 08:12", kind: "passkey-trust-reset", orphanedHostNames: ["minivac"] },
];

const requester: RequesterClaims = {
  claimedName: "iPad Air",
  claimedPlatform: "iPadOS · Safari",
  requestedAt: "14:02",
};

const linkNewStates: [string, LinkDeviceNewState][] = [
  [
    "choose — passkey available (passkey-first fork)",
    { step: "choose", passkeyAvailable: true, hostCount: 3 },
  ],
  [
    "choose — no passkey (ceremony is the only path)",
    { step: "choose", passkeyAvailable: false, hostCount: 3 },
  ],
  ["waiting-for-approver", { step: "waiting-for-approver" }],
  [
    "showing-code",
    {
      step: "showing-code",
      code: "483291",
      approverName: "Jeremy's MacBook Pro",
      expiresInSeconds: 120,
    },
  ],
  [
    "linked — backed by passkey",
    { step: "linked", approverName: "Jeremy's MacBook Pro", backedByPasskey: true, hostCount: 3 },
  ],
  [
    "linked — vouched only (pre-heal)",
    { step: "linked", approverName: "Pixel 9", backedByPasskey: false, hostCount: 2 },
  ],
  ["declined (mismatch or refusal on the other side)", { step: "declined" }],
  ["expired", { step: "expired" }],
  ["integrity-failure (commitment check failed — loud abort)", { step: "integrity-failure" }],
  ["error", { step: "error", message: "The connection dropped while waiting." }],
];

const approveStates: [string, LinkDeviceApproveState][] = [
  ["incoming (claims labeled unverified)", { step: "incoming", requester }],
  [
    "enter-code — first attempt",
    { step: "enter-code", requester, attemptsRemaining: 3, wrongEntry: false },
  ],
  [
    "enter-code — after a wrong entry",
    { step: "enter-code", requester, attemptsRemaining: 2, wrongEntry: true },
  ],
  ["verifying", { step: "verifying" }],
  [
    "approved — backed by passkey",
    { step: "approved", deviceName: "iPad Air", backedByPasskey: true, hostCount: 3 },
  ],
  [
    "approved — vouched only",
    { step: "approved", deviceName: "iPad Air", backedByPasskey: false, hostCount: 2 },
  ],
  ["mismatch-reported (user pressed 'codes don't match')", { step: "mismatch-reported" }],
  ["attempts-exhausted", { step: "attempts-exhausted" }],
  ["expired", { step: "expired" }],
  ["error", { step: "error", message: "The connection dropped while verifying." }],
];

const pairHostStates: [string, PairHostState][] = [
  [
    "instructions",
    {
      step: "instructions",
      command: "curl -fsSL https://spawnd.dev/install.sh | sh && spawnd pair",
    },
  ],
  ["waiting-for-host", { step: "waiting-for-host" }],
  [
    "enter-code — first attempt",
    { step: "enter-code", hostName: "atlas", attemptsRemaining: 3, wrongEntry: false },
  ],
  [
    "enter-code — after a wrong entry",
    { step: "enter-code", hostName: "atlas", attemptsRemaining: 1, wrongEntry: true },
  ],
  [
    "fingerprint-fallback (legacy host — full-entropy compare, the one tap-to-confirm)",
    {
      step: "fingerprint-fallback",
      hostName: "old-nas",
      fingerprintGroups: ["7f2a", "91cc", "0be3", "44d1", "a8f0", "3e97"],
    },
  ],
  ["verifying", { step: "verifying" }],
  ["paired — backed by passkey", { step: "paired", hostName: "atlas", backedByPasskey: true }],
  [
    "paired — no passkey (R5 warning inline)",
    { step: "paired", hostName: "atlas", backedByPasskey: false },
  ],
  ["mismatch-reported", { step: "mismatch-reported" }],
  ["attempts-exhausted", { step: "attempts-exhausted" }],
  ["expired", { step: "expired" }],
  ["error", { step: "error", message: "The connection dropped while waiting for the host." }],
];

const passkeyStates: [string, PasskeyOnboardingState][] = [
  ["offer (first screen after first sign-in)", { step: "offer" }],
  ["creating", { step: "creating" }],
  ["done", { step: "done" }],
  ["cost-sheet (the no-passkey contract, R8)", { step: "cost-sheet" }],
  ["error", { step: "error", message: "Your browser cancelled the passkey prompt." }],
];

const recoveryStates: [string, RecoveryState][] = [
  ["intro", { step: "intro", hostCount: 3 }],
  ["unlocking", { step: "unlocking" }],
  ["restoring", { step: "restoring" }],
  ["restored", { step: "restored", hostCount: 3 }],
  [
    "lockout (no passkey, R8 — the honest dead end)",
    { step: "lockout", hostNames: ["dream", "minivac"] },
  ],
  ["error", { step: "error", message: "The passkey prompt didn't complete." }],
];

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function TrustUxDemoPage() {
  return (
    <main className="min-h-screen bg-neutral-100 px-6 py-10 text-neutral-900">
      <div className="mx-auto max-w-5xl space-y-12">
        <header>
          <h1 className="text-2xl font-bold">spawn trust UX — every component, every state</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Clean-room design from docs/TRUST.md + docs/TRUST_DEVICE_MESH.md. Spec:
            web/src/trust-ux/DESIGN.md. All data is mocked; every action logs to the console.
          </p>
        </header>

        <Section
          title="1 · Security overview strip"
          note="DESIGN.md §4.1 — passkey state, counts, every warning with its remedy."
        >
          <Example label="passkey active, no warnings (steady state)">
            <SecurityOverview
              passkey={{ state: "active", createdAt: "Mar 2" }}
              deviceCount={3}
              hostCount={3}
              warnings={[]}
              onCreatePasskey={log("overview.onCreatePasskey")}
              onResetPasskeyTrust={log("overview.onResetPasskeyTrust")}
              onWarningAction={log("overview.onWarningAction")}
            />
          </Example>
          <Example label="passkey active, with warnings (sole-key host · awaiting backup · new-device nudge)">
            <SecurityOverview
              passkey={{ state: "active", createdAt: "Mar 2" }}
              deviceCount={3}
              hostCount={3}
              warnings={[
                { kind: "sole-key-host", hostName: "atlas", deviceName: "Work ThinkPad" },
                { kind: "awaiting-passkey-backup", deviceCount: 1 },
                { kind: "new-device-nudge", deviceName: "Work ThinkPad", addedAt: "Aug 18" },
              ]}
              onCreatePasskey={log("overview.onCreatePasskey")}
              onResetPasskeyTrust={log("overview.onResetPasskeyTrust")}
              onWarningAction={log("overview.onWarningAction")}
            />
          </Example>
          <Example label="no passkey (permanent signage, R8)">
            <SecurityOverview
              passkey={{ state: "none" }}
              deviceCount={1}
              hostCount={2}
              warnings={[{ kind: "single-device-no-passkey" }]}
              onCreatePasskey={log("overview.onCreatePasskey")}
              onResetPasskeyTrust={log("overview.onResetPasskeyTrust")}
              onWarningAction={log("overview.onWarningAction")}
            />
          </Example>
        </Section>

        <Section
          title="2 · Device roster"
          note="DESIGN.md §4.2 — the R4 detection surface: provenance sentences, status pills, sole-key warnings, always-visible Remove."
        >
          <Example label="passkey mode — backed, vouched (pre-heal), sole-key warning">
            <DeviceRoster
              devices={devicesPasskeyMode}
              passkeyActive={true}
              onLinkDevice={log("roster.onLinkDevice")}
              onRemoveDevice={log("roster.onRemoveDevice")}
            />
          </Example>
          <Example label="no-passkey mode — vouch provenance is the only structure">
            <DeviceRoster
              devices={devicesNoPasskeyMode}
              passkeyActive={false}
              onLinkDevice={log("roster.onLinkDevice")}
              onRemoveDevice={log("roster.onRemoveDevice")}
            />
          </Example>
        </Section>

        <Section
          title="3 · Host trust list"
          note="DESIGN.md §4.3 — backed / paired-only (R5 pre-warning) / orphaned, plus offline pending-removal wording (P3)."
        >
          <Example label="all host states in one list">
            <HostTrustList
              hosts={hosts}
              onPairHost={log("hosts.onPairHost")}
              onShowPairingInstructions={log("hosts.onShowPairingInstructions")}
            />
          </Example>
        </Section>

        <Section
          title="4 · Trust history"
          note="DESIGN.md §4.4 — every event kind, including failed ceremonies (danger tone)."
        >
          <Example label="all ten event kinds">
            <TrustHistory events={history} />
          </Example>
        </Section>

        <Section
          title="5 · Link this device (joining side)"
          note="DESIGN.md §5.3 — passkey-first fork; the new device displays the code, the trusted device types it."
        >
          {linkNewStates.map(([label, state]) => (
            <Example key={label} label={label}>
              <LinkDeviceNew
                state={state}
                onUsePasskey={log("linkNew.onUsePasskey")}
                onStartApproval={log("linkNew.onStartApproval")}
                onCancel={log("linkNew.onCancel")}
                onStartOver={log("linkNew.onStartOver")}
                onDone={log("linkNew.onDone")}
              />
            </Example>
          ))}
        </Section>

        <Section
          title="6 · Approve a device (trusted side)"
          note="DESIGN.md §5.3 — claims labeled unverified; entry-style code check with three attempts and the always-visible mismatch escape."
        >
          {approveStates.map(([label, state]) => (
            <Example key={label} label={label}>
              <LinkDeviceApprove
                state={state}
                onContinue={log("approve.onContinue")}
                onDismiss={log("approve.onDismiss")}
                onSubmitCode={log("approve.onSubmitCode")}
                onReportMismatch={log("approve.onReportMismatch")}
                onDone={log("approve.onDone")}
              />
            </Example>
          ))}
        </Section>

        <Section
          title="7 · Pair a host"
          note="DESIGN.md §5.2 — terminal shows the code, browser types it; legacy hosts fall back to the full-fingerprint compare, never a weak short code."
        >
          {pairHostStates.map(([label, state]) => (
            <Example key={label} label={label}>
              <PairHost
                state={state}
                onCopyCommand={log("pairHost.onCopyCommand")}
                onCancel={log("pairHost.onCancel")}
                onStartOver={log("pairHost.onStartOver")}
                onSubmitCode={log("pairHost.onSubmitCode")}
                onReportMismatch={log("pairHost.onReportMismatch")}
                onFingerprintsMatch={log("pairHost.onFingerprintsMatch")}
                onFingerprintsDiffer={log("pairHost.onFingerprintsDiffer")}
                onDone={log("pairHost.onDone")}
              />
            </Example>
          ))}
        </Section>

        <Section
          title="8 · Passkey setup"
          note="DESIGN.md §5.1 + §5.6 — offered before anything else; skipping goes through the cost sheet, never past it."
        >
          {passkeyStates.map(([label, state]) => (
            <Example key={label} label={label}>
              <PasskeyOnboarding
                state={state}
                onCreatePasskey={log("passkey.onCreatePasskey")}
                onSkip={log("passkey.onSkip")}
                onAcceptLockoutRisk={log("passkey.onAcceptLockoutRisk")}
                onBackToCreate={log("passkey.onBackToCreate")}
                onContinue={log("passkey.onContinue")}
              />
            </Example>
          ))}
        </Section>

        <Section
          title="9 · Recovery after total loss"
          note="DESIGN.md §5.4 — one passkey unlock restores everything; without one, the honest lockout."
        >
          {recoveryStates.map(([label, state]) => (
            <Example key={label} label={label}>
              <RecoveryFlow
                state={state}
                onUnlockWithPasskey={log("recovery.onUnlockWithPasskey")}
                onShowPairingInstructions={log("recovery.onShowPairingInstructions")}
                onDone={log("recovery.onDone")}
                onRetry={log("recovery.onRetry")}
              />
            </Example>
          ))}
        </Section>

        <Section
          title="10 · Remove a device"
          note="DESIGN.md §5.5 — the three consequence tiers, computed and named; steady state says 'nothing else is affected'."
        >
          <Example label="steady state — zero blast radius (P3'')">
            <RemoveDeviceDialog
              device={devicesPasskeyMode[1]}
              consequences={{
                onlineHostCount: 3,
                offlineHostCount: 0,
                hasLiveSessions: false,
                orphanedHostNames: [],
                collateralDevices: [],
              }}
              passkeyActive={true}
              onConfirmRemove={log("remove.onConfirmRemove")}
              onBackHostsFirst={log("remove.onBackHostsFirst")}
              onCancel={log("remove.onCancel")}
            />
          </Example>
          <Example label="live sessions + offline hosts (P3 precise wording, R1)">
            <RemoveDeviceDialog
              device={devicesPasskeyMode[1]}
              consequences={{
                onlineHostCount: 2,
                offlineHostCount: 1,
                hasLiveSessions: true,
                orphanedHostNames: [],
                collateralDevices: [],
              }}
              passkeyActive={true}
              onConfirmRemove={log("remove.onConfirmRemove")}
              onBackHostsFirst={log("remove.onBackHostsFirst")}
              onCancel={log("remove.onCancel")}
            />
          </Example>
          <Example label="orphans a host, passkey available — heal-first primary action (R5)">
            <RemoveDeviceDialog
              device={devicesPasskeyMode[2]}
              consequences={{
                onlineHostCount: 2,
                offlineHostCount: 1,
                hasLiveSessions: false,
                orphanedHostNames: ["atlas"],
                collateralDevices: [],
              }}
              passkeyActive={true}
              onConfirmRemove={log("remove.onConfirmRemove")}
              onBackHostsFirst={log("remove.onBackHostsFirst")}
              onCancel={log("remove.onCancel")}
            />
          </Example>
          <Example label="orphans hosts + collateral devices, no passkey — acknowledge required">
            <RemoveDeviceDialog
              device={devicesNoPasskeyMode[0]}
              consequences={{
                onlineHostCount: 1,
                offlineHostCount: 1,
                hasLiveSessions: true,
                orphanedHostNames: ["dream", "minivac"],
                collateralDevices: [{ deviceName: "Pixel 9", restoredByNextPasskeyUse: false }],
              }}
              passkeyActive={false}
              onConfirmRemove={log("remove.onConfirmRemove")}
              onBackHostsFirst={log("remove.onBackHostsFirst")}
              onCancel={log("remove.onCancel")}
            />
          </Example>
          <Example label="collateral device restored by next passkey use (P3'' transient window)">
            <RemoveDeviceDialog
              device={devicesPasskeyMode[1]}
              consequences={{
                onlineHostCount: 3,
                offlineHostCount: 0,
                hasLiveSessions: false,
                orphanedHostNames: [],
                collateralDevices: [
                  { deviceName: "Work ThinkPad", restoredByNextPasskeyUse: true },
                ],
              }}
              passkeyActive={true}
              onConfirmRemove={log("remove.onConfirmRemove")}
              onBackHostsFirst={log("remove.onBackHostsFirst")}
              onCancel={log("remove.onCancel")}
            />
          </Example>
        </Section>

        <Section
          title="11 · Reset passkey trust (the root)"
          note="DESIGN.md §5.5 — suspected passkey compromise only; typed confirmation; §4.1 rotation consequences named."
        >
          <Example label="with hosts that would be orphaned">
            <ResetPasskeyTrustDialog
              orphanedHostNames={["dream"]}
              deviceCount={3}
              onConfirmReset={log("reset.onConfirmReset")}
              onCancel={log("reset.onCancel")}
            />
          </Example>
          <Example label="no hosts rely only on the passkey">
            <ResetPasskeyTrustDialog
              orphanedHostNames={[]}
              deviceCount={2}
              onConfirmReset={log("reset.onConfirmReset")}
              onCancel={log("reset.onCancel")}
            />
          </Example>
        </Section>

        <Section
          title="12 · Connection-refused moments"
          note="DESIGN.md §5.7 — terminal states with a named remedy; never spinners, never 'connection failed'."
        >
          <Example label="device-removed (at connect)">
            <ConnectionGate
              refusal={{
                kind: "device-removed",
                removedAt: "Aug 19",
                removedByDeviceName: "Jeremy's MacBook Pro",
              }}
              onUsePasskey={log("gate.onUsePasskey")}
              onLinkThisDevice={log("gate.onLinkThisDevice")}
              onShowPairingInstructions={log("gate.onShowPairingInstructions")}
              onOpenSecurity={log("gate.onOpenSecurity")}
            />
          </Example>
          <Example label="session-ended-removed (R1 live teardown — never rendered as 'reconnecting')">
            <ConnectionGate
              refusal={{ kind: "session-ended-removed" }}
              onUsePasskey={log("gate.onUsePasskey")}
              onLinkThisDevice={log("gate.onLinkThisDevice")}
              onShowPairingInstructions={log("gate.onShowPairingInstructions")}
              onOpenSecurity={log("gate.onOpenSecurity")}
            />
          </Example>
          <Example label="trust-path-broken — passkey available">
            <ConnectionGate
              refusal={{
                kind: "trust-path-broken",
                throughDeviceName: "iPhone",
                passkeyAvailable: true,
              }}
              onUsePasskey={log("gate.onUsePasskey")}
              onLinkThisDevice={log("gate.onLinkThisDevice")}
              onShowPairingInstructions={log("gate.onShowPairingInstructions")}
              onOpenSecurity={log("gate.onOpenSecurity")}
            />
          </Example>
          <Example label="trust-path-broken — no passkey">
            <ConnectionGate
              refusal={{
                kind: "trust-path-broken",
                throughDeviceName: "Framework laptop",
                passkeyAvailable: false,
              }}
              onUsePasskey={log("gate.onUsePasskey")}
              onLinkThisDevice={log("gate.onLinkThisDevice")}
              onShowPairingInstructions={log("gate.onShowPairingInstructions")}
              onOpenSecurity={log("gate.onOpenSecurity")}
            />
          </Example>
          <Example label="host-orphaned (R5 happened — no remote fix, by design)">
            <ConnectionGate
              refusal={{ kind: "host-orphaned", hostName: "minivac" }}
              onUsePasskey={log("gate.onUsePasskey")}
              onLinkThisDevice={log("gate.onLinkThisDevice")}
              onShowPairingInstructions={log("gate.onShowPairingInstructions")}
              onOpenSecurity={log("gate.onOpenSecurity")}
            />
          </Example>
          <Example label="host-added-elsewhere (R7 gap, no-passkey mode)">
            <ConnectionGate
              refusal={{
                kind: "host-added-elsewhere",
                hostName: "dream",
                pairingDeviceName: "Framework laptop",
              }}
              onUsePasskey={log("gate.onUsePasskey")}
              onLinkThisDevice={log("gate.onLinkThisDevice")}
              onShowPairingInstructions={log("gate.onShowPairingInstructions")}
              onOpenSecurity={log("gate.onOpenSecurity")}
            />
          </Example>
        </Section>

        <Section
          title="13 · Session verified chip"
          note="DESIGN.md §5.7 — always present when connected, so its absence is meaningful."
        >
          <Example label="basis: passkey">
            <VerifiedChip basis={{ kind: "passkey" }} />
          </Example>
          <Example label="basis: vouched by a device">
            <VerifiedChip basis={{ kind: "device", deviceName: "Jeremy's MacBook Pro" }} />
          </Example>
        </Section>
      </div>
    </main>
  );
}
