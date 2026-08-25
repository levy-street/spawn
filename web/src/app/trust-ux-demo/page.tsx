"use client";

import type { ReactNode } from "react";
import { AccessBlocked } from "@/trust-ux/AccessBlocked";
import { AccessScreen } from "@/trust-ux/AccessScreen";
import { ApproveRequest, ApproveRequestToast, WaitingForApproval } from "@/trust-ux/ApproveDevice";
import { NumberCheck } from "@/trust-ux/NumberCheck";
import { PossessHost } from "@/trust-ux/PossessHost";
import { RemoveDeviceDialog } from "@/trust-ux/RemoveDevice";
import { TrustHistory } from "@/trust-ux/TrustHistory";
import type { DeviceVM, HostVM, TrustEventVM } from "@/trust-ux/types";

const noop = () => undefined;

const devices: DeviceVM[] = [
  {
    id: "d1",
    name: "MacBook Pro",
    kind: "laptop",
    isThisDevice: true,
    provenance: "First device",
    lastSeen: "Now",
  },
  {
    id: "d2",
    name: "iPhone",
    kind: "phone",
    provenance: "Approved by MacBook Pro · Jun 3",
    lastSeen: "2h ago",
  },
  {
    id: "d3",
    name: "Pixel 9",
    kind: "phone",
    provenance: "Signed in with passkey · Jul 2",
    lastSeen: "Aug 12",
  },
];

const waitingDevice: DeviceVM = {
  id: "d4",
  name: "Firefox on Mac",
  kind: "laptop",
  provenance: "Signed in 2 minutes ago",
  lastSeen: "Now",
  waiting: true,
};

const hosts: HostVM[] = [
  { id: "c1", name: "mac-studio", provenance: "Possessed by MacBook Pro · May 28", online: true },
  { id: "c2", name: "dev-box", provenance: "Possessed by iPhone · Jun 20", online: false },
];

const history: TrustEventVM[] = [
  { id: "e1", text: "Pixel 9 signed in with passkey", when: "Jul 2", kind: "passkey" },
  { id: "e2", text: "iPhone possessed dev-box", when: "Jun 20", kind: "approved" },
  { id: "e3", text: "MacBook Pro approved iPhone", when: "Jun 3", kind: "approved" },
  { id: "e4", text: "MacBook Pro possessed mac-studio", when: "May 28", kind: "approved" },
  { id: "e5", text: "Old iPad removed by MacBook Pro", when: "Apr 19", kind: "removed" },
  { id: "e6", text: "Passkey added", when: "Apr 2", kind: "passkey" },
];

export default function TrustUxDemoPage() {
  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-14 text-zinc-300 antialiased sm:px-6">
      <div className="mx-auto max-w-7xl">
        <header className="max-w-2xl">
          <h1 className="text-2xl font-medium tracking-tight text-zinc-100">
            SPAWN D trust — every screen, every state
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-500">
            Two nouns (device, host), three verbs (approve, possess, remove), one artifact (the
            number) — plus the passkey, borrowed from the platform, never taught. Nothing else
            reaches a screen.
          </p>
        </header>

        <DemoSection
          id="roster"
          title="Access — the one destination"
          blurb="A device appears here the moment it signs in; approval is the transition, not the insertion. Row provenance and history lines are the audit trail, in plain words."
        >
          <Variant label="Default">
            <PagePanel>
              <AccessScreen
                devices={devices}
                hosts={hosts}
                history={history}
                onNewDevice={noop}
                onPossessHost={noop}
                onDeviceOptions={noop}
                onShowHistory={noop}
              />
            </PagePanel>
          </Variant>
          <Variant label="A device waiting for approval">
            <PagePanel>
              <AccessScreen
                devices={[...devices.slice(0, 2), waitingDevice]}
                hosts={hosts}
                history={history}
                onNewDevice={noop}
                onPossessHost={noop}
                onApproveDevice={noop}
                onDeviceOptions={noop}
                onShowHistory={noop}
              />
            </PagePanel>
          </Variant>
          <Variant label="No passkey — the one nudge">
            <PagePanel>
              <AccessScreen
                devices={devices.slice(0, 2)}
                hosts={hosts}
                history={history.filter((e) => e.kind !== "passkey")}
                passkeyNudge
                onNewDevice={noop}
                onPossessHost={noop}
                onDeviceOptions={noop}
                onAddPasskey={noop}
                onDismissNudge={noop}
                onShowHistory={noop}
              />
            </PagePanel>
          </Variant>
        </DemoSection>

        <DemoSection
          id="desktop"
          title="Desktop"
          blurb="The same system in an app window: the roster as a settings pane, the row menu, confirms over the page, and an approval request arriving as a corner toast."
        >
          <Variant label="Settings — row menu open">
            <DesktopFrame>
              <AccessScreen
                wide
                devices={devices}
                hosts={hosts}
                history={history}
                openMenuDeviceId="d2"
                onNewDevice={noop}
                onPossessHost={noop}
                onDeviceOptions={noop}
                onRenameDevice={noop}
                onRemoveDevice={noop}
                onShowHistory={noop}
              />
            </DesktopFrame>
          </Variant>
          <Variant label="Remove confirm — over the page">
            <DesktopFrame
              overlay={
                <RemoveDeviceDialog
                  deviceName="iPhone"
                  hasPasskey
                  onRemove={noop}
                  onCancel={noop}
                />
              }
            >
              <AccessScreen
                wide
                devices={devices}
                hosts={hosts}
                history={history}
                onNewDevice={noop}
                onPossessHost={noop}
                onDeviceOptions={noop}
                onShowHistory={noop}
              />
            </DesktopFrame>
          </Variant>
          <Variant label="A new device asks — waiting row + corner toast">
            <DesktopFrame
              toast={
                <ApproveRequestToast
                  deviceName="Firefox on Mac"
                  deviceKind="laptop"
                  onEnterNumber={noop}
                  onIgnore={noop}
                />
              }
            >
              <AccessScreen
                wide
                devices={[...devices.slice(0, 2), waitingDevice]}
                hosts={hosts}
                history={history}
                onNewDevice={noop}
                onPossessHost={noop}
                onApproveDevice={noop}
                onDeviceOptions={noop}
                onShowHistory={noop}
              />
            </DesktopFrame>
          </Variant>
        </DemoSection>

        <DemoSection
          id="link-device"
          title="Approve a device"
          blurb="Both sides of the approval. The new device shows the number; the trusted device types it — entering is the check, so it can't be waved through. With a passkey none of these screens exist: signing in is the approval."
        >
          <Variant label="New device — waiting">
            <WaitingForApproval onCancel={noop} />
          </Variant>
          <Variant label="Existing device — request">
            <ApproveRequest
              deviceName="iPhone"
              deviceKind="phone"
              account="jeremy@levystreet.com"
              onEnterNumber={noop}
              onIgnore={noop}
            />
          </Variant>
          <Variant label="New device — shows its number">
            <NumberCheck
              phase="compare"
              mode="show"
              number="923 579"
              title="Approve this device"
              otherScreen="on the device you already use"
              doneText=""
              onClose={noop}
            />
          </Variant>
          <Variant label="Trusted device — types it">
            <NumberCheck
              phase="compare"
              mode="enter"
              title="Approve iPhone"
              otherScreen="on the new device"
              doneText=""
              onSubmit={noop}
              onNoMatch={noop}
            />
          </Variant>
          <Variant label="Wrong entry">
            <NumberCheck
              phase="compare"
              mode="enter"
              title="Approve iPhone"
              otherScreen="on the new device"
              doneText=""
              entryError="That's not it — 2 tries left."
              onSubmit={noop}
              onNoMatch={noop}
            />
          </Variant>
          <Variant label="Done">
            <NumberCheck
              phase="done"
              mode="enter"
              title="Approve iPhone"
              otherScreen="on the new device"
              doneText="iPhone is approved. Every host is ready."
              onDone={noop}
            />
          </Variant>
        </DemoSection>

        <DemoSection
          id="connect-computer"
          title="Possess a host"
          blurb="The product's own verb — the same one the terminal prints. One command on the host; its terminal shows the number and this device types it."
        >
          <Variant label="Step 1 — the command">
            <PossessHost command="spawnd possess" onCancel={noop} />
          </Variant>
          <Variant label="The host's terminal">
            <TerminalMock />
          </Variant>
          <Variant label="This device — types it">
            <NumberCheck
              phase="compare"
              mode="enter"
              title="Possess mac-studio"
              otherScreen="in the host's terminal"
              doneText=""
              onSubmit={noop}
              onNoMatch={noop}
            />
          </Variant>
          <Variant label="Older host — fingerprint">
            <NumberCheck
              phase="compare"
              mode="enter"
              fingerprint="pv4_JydeAk0APeP4mQ2c"
              title="Possess dev-box"
              otherScreen="in the host's terminal"
              doneText=""
              onMatch={noop}
              onNoMatch={noop}
            />
          </Variant>
          <Variant label="Done">
            <NumberCheck
              phase="done"
              mode="enter"
              title="Possess mac-studio"
              otherScreen="in the host's terminal"
              doneText="mac-studio is possessed. All your devices can reach it."
              onDone={noop}
            />
          </Variant>
        </DemoSection>

        <DemoSection
          id="ceremony-states"
          title="The number check — remaining states"
          blurb="Mismatch is terminal: there is no approve-anyway. The machinery before the number is one spinner."
        >
          <Variant label="Securing">
            <NumberCheck
              phase="connecting"
              mode="enter"
              title="Approve iPhone"
              otherScreen="on the new device"
              doneText=""
            />
          </Variant>
          <Variant label="You confirmed — other side pending">
            <NumberCheck
              phase="waiting"
              mode="show"
              number="923 579"
              title="Approve this device"
              otherScreen="on the other device"
              doneText=""
            />
          </Variant>
          <Variant label="Waiting, slowly">
            <NumberCheck
              phase="waiting"
              mode="show"
              number="923 579"
              title="Approve this device"
              otherScreen="on the other device"
              doneText=""
              slowHint
            />
          </Variant>
          <Variant label="Numbers don't match — stop">
            <NumberCheck
              phase="stopped"
              mode="enter"
              title="Approve iPhone"
              otherScreen="on the new device"
              doneText=""
              onClose={noop}
            />
          </Variant>
        </DemoSection>

        <DemoSection
          id="remove"
          title="Remove a device"
          blurb="Instant, everywhere, permanent — one breath. If a host would be stranded, the dialog names it — and only promises the passkey fix when the host is online to receive it."
        >
          <Variant label="Standard">
            <RemoveDeviceDialog deviceName="iPhone" hasPasskey onRemove={noop} onCancel={noop} />
          </Variant>
          <Variant label="Would strand a host — no passkey">
            <RemoveDeviceDialog
              deviceName="MacBook Pro"
              orphans={[{ name: "mac-studio", online: true }]}
              hasPasskey={false}
              onRemove={noop}
              onCancel={noop}
              onAddPasskey={noop}
            />
          </Variant>
          <Variant label="Would strand a host — with passkey">
            <RemoveDeviceDialog
              deviceName="MacBook Pro"
              orphans={[{ name: "mac-studio", online: true }]}
              hasPasskey
              onRemove={noop}
              onCancel={noop}
            />
          </Variant>
          <Variant label="Stranded host is offline">
            <RemoveDeviceDialog
              deviceName="iPhone"
              orphans={[{ name: "dev-box", online: false }]}
              hasPasskey
              onRemove={noop}
              onCancel={noop}
            />
          </Variant>
          <Variant label="This device">
            <RemoveDeviceDialog
              deviceName="MacBook Pro"
              isThisDevice
              hasPasskey
              onRemove={noop}
              onCancel={noop}
            />
          </Variant>
        </DemoSection>

        <DemoSection
          id="blocked"
          title="Connection refused"
          blurb="A refused device gets its exact next step, never a raw error. Removal names who removed it."
        >
          <Variant label="Removed device">
            <AccessBlocked
              variant="removed"
              detail="Removed Aug 12 by MacBook Pro."
              onStartOver={noop}
              onSignOut={noop}
            />
          </Variant>
          <Variant label="Not approved yet">
            <AccessBlocked variant="not-approved" onUsePasskey={noop} onSignOut={noop} />
          </Variant>
        </DemoSection>

        <DemoSection
          id="history"
          title="History — the full log"
          blurb="Every trust change is one sentence. A rogue approval is meant to be noticed here, then removed."
        >
          <Variant label="All events">
            <PagePanel>
              <TrustHistory events={history} />
            </PagePanel>
          </Variant>
        </DemoSection>
      </div>
    </main>
  );
}

/* ---------- demo chrome (not part of the design system) ---------- */

function DemoSection({
  id,
  title,
  blurb,
  children,
}: {
  id: string;
  title: string;
  blurb: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mt-14 border-t border-zinc-800/60 pt-12">
      <h2 className="text-lg font-medium tracking-tight text-zinc-100">{title}</h2>
      <p className="mt-1 max-w-xl text-sm leading-relaxed text-zinc-500">{blurb}</p>
      <div id={`${id}-grid`} className="mt-8 flex flex-wrap items-start gap-x-8 gap-y-10">
        {children}
      </div>
    </section>
  );
}

function Variant({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 max-w-full">
      <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-zinc-600">{label}</p>
      {children}
    </div>
  );
}

/** Frames full-page surfaces (roster, history) the way `Screen` frames flows. */
function PagePanel({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-full rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 shadow-xl shadow-black/20 sm:p-6">
      {children}
    </div>
  );
}

/** A mock app window: sidebar + content, with optional dialog overlay or corner toast. */
function DesktopFrame({
  children,
  overlay,
  toast,
}: {
  children: ReactNode;
  overlay?: ReactNode;
  toast?: ReactNode;
}) {
  const nav = ["Dash", "Agents", "Hosts", "Screens", "Access"];
  return (
    <div className="relative w-[1080px] max-w-full overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-xl shadow-black/30">
      <div className="flex">
        <aside className="flex w-52 shrink-0 flex-col border-r border-zinc-800/70 bg-zinc-900/30 p-4">
          <p className="px-2 text-sm font-semibold tracking-tight text-zinc-100">SPAWN D</p>
          <nav className="mt-5 space-y-0.5">
            {nav.map((item) => (
              <p
                key={item}
                className={`rounded-lg px-2 py-1.5 text-sm ${
                  item === "Access" ? "bg-zinc-800/80 text-zinc-100" : "text-zinc-500"
                }`}
              >
                {item}
              </p>
            ))}
          </nav>
          <p className="mt-auto truncate px-2 pt-8 text-xs text-zinc-600">jeremy@levystreet.com</p>
        </aside>
        <div className="min-h-[560px] min-w-0 flex-1 p-8">{children}</div>
      </div>
      {overlay !== undefined && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          {overlay}
        </div>
      )}
      {toast !== undefined && <div className="absolute right-5 top-5">{toast}</div>}
    </div>
  );
}

/** What the daemon prints during `spawnd possess` — shown for flow context. */
function TerminalMock() {
  return (
    <div className="w-[340px] rounded-2xl border border-zinc-800 bg-zinc-950 p-5 font-mono text-[13px] leading-relaxed shadow-xl shadow-black/20">
      <p className="text-zinc-500">
        <span className="select-none">$ </span>spawnd possess
      </p>
      <p className="mt-1 text-zinc-400">Possessing this host for your account…</p>
      <p className="mt-4 text-zinc-500">Your number:</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-[0.14em] text-zinc-50">
        923 579
      </p>
      <p className="mt-4 text-zinc-400">On your device, enter this number.</p>
    </div>
  );
}
