"use client";

import type { ReactNode } from "react";
import { AccessBlocked } from "@/trust-ux/AccessBlocked";
import { ConnectComputer } from "@/trust-ux/ConnectComputer";
import { DevicesScreen } from "@/trust-ux/DevicesScreen";
import { LinkNewDevice, LinkRequest } from "@/trust-ux/LinkDevice";
import { NumberCheck } from "@/trust-ux/NumberCheck";
import { ResetRecoveryDialog, TurnOnRecoveryDialog } from "@/trust-ux/Recovery";
import { RemoveDeviceDialog } from "@/trust-ux/RemoveDevice";
import { TrustHistory } from "@/trust-ux/TrustHistory";
import type { ComputerVM, DeviceVM, TrustEventVM } from "@/trust-ux/types";

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
    provenance: "Linked by MacBook Pro · Jun 3",
    lastSeen: "2h ago",
  },
  {
    id: "d3",
    name: "Pixel 9",
    kind: "phone",
    provenance: "Added by recovery · Jul 2",
    lastSeen: "Aug 12",
  },
];

const computers: ComputerVM[] = [
  { id: "c1", name: "mac-studio", provenance: "Set up by MacBook Pro · May 28", online: true },
  { id: "c2", name: "dev-box", provenance: "Set up by iPhone · Jun 20", online: false },
];

const history: TrustEventVM[] = [
  { id: "e1", text: "Recovery restored Pixel 9", when: "Jul 2", kind: "recovery" },
  { id: "e2", text: "iPhone connected dev-box", when: "Jun 20", kind: "added" },
  { id: "e3", text: "MacBook Pro linked iPhone", when: "Jun 3", kind: "added" },
  { id: "e4", text: "MacBook Pro connected mac-studio", when: "May 28", kind: "added" },
  { id: "e5", text: "Old iPad removed by MacBook Pro", when: "Apr 19", kind: "removed" },
  { id: "e6", text: "Recovery turned on", when: "Apr 2", kind: "recovery" },
];

export default function TrustUxDemoPage() {
  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-14 text-zinc-300 antialiased sm:px-6">
      <div className="mx-auto max-w-7xl">
        <header className="max-w-2xl">
          <h1 className="text-2xl font-medium tracking-tight text-zinc-100">
            spawn trust — every screen, every state
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-500">
            Three nouns (device, computer, recovery), three verbs (link, connect, remove), one
            artifact (the number). Nothing else reaches a screen.
          </p>
        </header>

        <DemoSection
          id="roster"
          title="Devices — the one destination"
          blurb="Everything about trust lives on one screen. Row provenance and history lines are the audit trail, in plain words."
        >
          <Variant label="Recovery on">
            <PagePanel>
              <DevicesScreen
                devices={devices}
                computers={computers}
                recovery={{ on: true, detail: "Your passkey can bring everything back." }}
                history={history}
                onLinkDevice={noop}
                onConnectComputer={noop}
                onDeviceOptions={noop}
                onResetRecovery={noop}
                onShowHistory={noop}
              />
            </PagePanel>
          </Variant>
          <Variant label="Recovery off (no-passkey mode)">
            <PagePanel>
              <DevicesScreen
                devices={devices.slice(0, 2)}
                computers={computers}
                recovery={{ on: false }}
                history={history.filter((e) => e.kind !== "recovery")}
                onLinkDevice={noop}
                onConnectComputer={noop}
                onDeviceOptions={noop}
                onTurnOnRecovery={noop}
                onShowHistory={noop}
              />
            </PagePanel>
          </Variant>
        </DemoSection>

        <DemoSection
          id="link-device"
          title="Link a new device"
          blurb="Both sides of the link. The new device shows the number; the trusted device types it — entering is the check, so it can't be waved through. With a passkey none of these screens exist: signing in is the whole flow."
        >
          <Variant label="New device — waiting">
            <LinkNewDevice onCancel={noop} />
          </Variant>
          <Variant label="Existing device — request">
            <LinkRequest
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
              title="Link this device"
              otherScreen="on the device you already use"
              doneText=""
              onClose={noop}
            />
          </Variant>
          <Variant label="Trusted device — types it">
            <NumberCheck
              phase="compare"
              mode="enter"
              title="Link iPhone"
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
              title="Link iPhone"
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
              title="Link iPhone"
              otherScreen="on the new device"
              doneText="iPhone is linked. Every computer is ready."
              onDone={noop}
            />
          </Variant>
        </DemoSection>

        <DemoSection
          id="connect-computer"
          title="Connect a computer"
          blurb="One command on the computer; its terminal shows the number and this device types it."
        >
          <Variant label="Step 1 — the command">
            <ConnectComputer command="spawnd possess" onCancel={noop} />
          </Variant>
          <Variant label="The computer's terminal">
            <TerminalMock />
          </Variant>
          <Variant label="This device — types it">
            <NumberCheck
              phase="compare"
              mode="enter"
              title="Connect mac-studio"
              otherScreen="in the computer's terminal"
              doneText=""
              onSubmit={noop}
              onNoMatch={noop}
            />
          </Variant>
          <Variant label="Older computer — fingerprint">
            <NumberCheck
              phase="compare"
              mode="enter"
              fingerprint="pv4_JydeAk0APeP4mQ2c"
              title="Connect dev-box"
              otherScreen="in the computer's terminal"
              doneText=""
              onMatch={noop}
              onNoMatch={noop}
            />
          </Variant>
          <Variant label="Done">
            <NumberCheck
              phase="done"
              mode="enter"
              title="Connect mac-studio"
              otherScreen="in the computer's terminal"
              doneText="mac-studio is connected. All your devices can reach it."
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
              title="Link iPhone"
              otherScreen="on the new device"
              doneText=""
            />
          </Variant>
          <Variant label="You confirmed — other side pending">
            <NumberCheck
              phase="waiting"
              mode="show"
              number="923 579"
              title="Link this device"
              otherScreen="on the other device"
              doneText=""
            />
          </Variant>
          <Variant label="Waiting, slowly">
            <NumberCheck
              phase="waiting"
              mode="show"
              number="923 579"
              title="Link this device"
              otherScreen="on the other device"
              doneText=""
              slowHint
            />
          </Variant>
          <Variant label="Numbers don't match — stop">
            <NumberCheck
              phase="stopped"
              mode="enter"
              title="Link iPhone"
              otherScreen="on the new device"
              doneText=""
              onClose={noop}
            />
          </Variant>
        </DemoSection>

        <DemoSection
          id="remove"
          title="Remove a device"
          blurb="Instant, everywhere, permanent — one breath. If a computer would be stranded, the dialog names it — and only promises the passkey fix when the computer is online to receive it."
        >
          <Variant label="Standard">
            <RemoveDeviceDialog deviceName="iPhone" recoveryOn onRemove={noop} onCancel={noop} />
          </Variant>
          <Variant label="Would strand a computer — recovery off">
            <RemoveDeviceDialog
              deviceName="MacBook Pro"
              orphans={[{ name: "mac-studio", online: true }]}
              recoveryOn={false}
              onRemove={noop}
              onCancel={noop}
              onTurnOnRecovery={noop}
            />
          </Variant>
          <Variant label="Would strand a computer — recovery on">
            <RemoveDeviceDialog
              deviceName="MacBook Pro"
              orphans={[{ name: "mac-studio", online: true }]}
              recoveryOn
              onRemove={noop}
              onCancel={noop}
            />
          </Variant>
          <Variant label="Stranded computer is offline">
            <RemoveDeviceDialog
              deviceName="iPhone"
              orphans={[{ name: "dev-box", online: false }]}
              recoveryOn
              onRemove={noop}
              onCancel={noop}
            />
          </Variant>
          <Variant label="This device">
            <RemoveDeviceDialog
              deviceName="MacBook Pro"
              isThisDevice
              recoveryOn
              onRemove={noop}
              onCancel={noop}
            />
          </Variant>
        </DemoSection>

        <DemoSection
          id="recovery"
          title="Recovery"
          blurb="One passkey, sold as what it does. Turning it on is the only decision; everything after is automatic."
        >
          <Variant label="Turn on">
            <TurnOnRecoveryDialog onCreate={noop} onNotNow={noop} />
          </Variant>
          <Variant label="Reset">
            <ResetRecoveryDialog onReset={noop} onCancel={noop} />
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
              onLink={noop}
              onSignOut={noop}
            />
          </Variant>
          <Variant label="Not linked yet">
            <AccessBlocked variant="not-linked" onLink={noop} onSignOut={noop} />
          </Variant>
        </DemoSection>

        <DemoSection
          id="history"
          title="History — the full log"
          blurb="Every trust change is one sentence. A rogue link is meant to be noticed here, then removed."
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

/** What the daemon prints during `spawnd possess` — shown for flow context. */
function TerminalMock() {
  return (
    <div className="w-[340px] rounded-2xl border border-zinc-800 bg-zinc-950 p-5 font-mono text-[13px] leading-relaxed shadow-xl shadow-black/20">
      <p className="text-zinc-500">
        <span className="select-none">$ </span>spawnd possess
      </p>
      <p className="mt-1 text-zinc-400">Connecting this computer to your account…</p>
      <p className="mt-4 text-zinc-500">Your number:</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-[0.14em] text-zinc-50">
        923 579
      </p>
      <p className="mt-4 text-zinc-400">On your device, enter this number.</p>
    </div>
  );
}
