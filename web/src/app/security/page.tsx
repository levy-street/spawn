import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Fingerprint,
  Flame,
  Lock,
  Network,
  Server,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Security — the server that can't read your terminal",
  description:
    "spawnd's control plane introduces your browser to the daemon, then goes deaf. Terminal I/O is end-to-end encrypted browser-to-daemon; the relay, when your network forces one, carries only ciphertext. The threat model names our own servers as the adversary.",
};

export default function SecurityPage() {
  return (
    <main className="grimoire min-h-vv overflow-hidden">
      {/* Nav */}
      <nav className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-6 sm:px-8">
        <Link
          href="/"
          className="inline-flex items-center gap-2 font-sigil text-[12px] tracking-[0.18em] text-ash uppercase transition-colors hover:text-bone"
        >
          <ArrowLeft className="size-4" />
          spawnd
        </Link>
        <Link
          href="/signup"
          className="rounded-sm border border-hellfire/60 px-3 py-1.5 font-sigil text-[12px] tracking-[0.18em] text-ember uppercase transition-colors hover:border-hellfire hover:text-hellfire"
        >
          Sign&nbsp;up
        </Link>
      </nav>

      {/* Hero */}
      <header className="relative overflow-hidden border-line-g border-b px-5 py-24 sm:px-8">
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 60% 55% at 50% 0%, rgba(255,73,48,.1), transparent 60%)",
          }}
        />
        <div className="relative mx-auto w-full max-w-3xl text-center">
          <p className="mb-4 font-sigil text-[12px] tracking-[0.34em] text-hellfire uppercase">
            Security
          </p>
          <h1 className="mb-6 font-grimoire text-[clamp(36px,7vw,64px)] font-medium leading-[1.02] text-bone [text-wrap:balance]">
            We introduce. We never listen.
          </h1>
          <p className="mx-auto max-w-[58ch] text-[18px] leading-8 text-ash">
            The control plane exists to bring your browser and your daemon into the same room. The
            moment they shake hands, it goes deaf. The distinction we build to:{" "}
            <em className="text-bone not-italic">the server cannot read your terminal</em> — not “we
            don’t look,” but “we can’t.”
          </p>
        </div>
      </header>

      {/* Principle */}
      <section className="border-line-g border-b px-5 py-20 sm:px-8">
        <div className="mx-auto w-full max-w-3xl">
          <blockquote className="border-hellfire border-l-2 pl-6 font-grimoire text-[clamp(22px,3.4vw,30px)] leading-[1.35] text-bone italic">
            “The only parties that handle your terminal are the daemon on your host and the browser
            in your hand. The server introduces them; it never sees the conversation.”
          </blockquote>
          <p className="mt-5 font-sigil text-[12px] tracking-[0.14em] text-ash">
            — the governing principle, verbatim from the threat model
          </p>
        </div>
      </section>

      {/* How it stays private */}
      <section className="border-line-g border-b px-5 py-20 sm:px-8">
        <div className="mx-auto w-full max-w-5xl">
          <p className="mb-3 font-sigil text-[12px] tracking-[0.3em] text-hellfire uppercase">
            How the server stays deaf
          </p>
          <h2 className="mb-12 max-w-2xl font-grimoire text-[clamp(26px,4.2vw,38px)] font-medium leading-[1.12] text-bone">
            End-to-end encrypted, browser to daemon.
          </h2>
          <div className="grid gap-px overflow-hidden rounded-md border border-line-g bg-line-g sm:grid-cols-2">
            <Mechanism icon={<Network className="size-5" />} title="Direct channels">
              Terminal input, output, and scrollback ride encrypted WebRTC DataChannels negotiated
              directly between the two endpoints. The keys live at the endpoints; the server holds
              none of them.
            </Mechanism>
            <Mechanism icon={<EyeOff className="size-5" />} title="Signaling only">
              The control plane carries auth, lifecycle, and the introduction handshake. There is no
              server code path for terminal content, no transcript store, nothing to hand over.
            </Mechanism>
            <Mechanism icon={<Lock className="size-5" />} title="Ciphertext relay, as a fallback">
              A relay is used only when NAT leaves no direct path. It then forwards opaque
              ciphertext it can’t decrypt — reachability without disclosure.
            </Mechanism>
            <Mechanism icon={<Server className="size-5" />} title="Outbound-only hosts">
              The daemon dials out and holds the line. No inbound ports, no exposed SSH, no tailnet.
              Nothing reaches in; the daemon only reaches out.
            </Mechanism>
          </div>
        </div>
      </section>

      {/* The honest ledger */}
      <section className="border-line-g border-b px-5 py-20 sm:px-8">
        <div className="mx-auto w-full max-w-5xl">
          <p className="mb-3 font-sigil text-[12px] tracking-[0.3em] text-hellfire uppercase">
            The honest ledger
          </p>
          <h2 className="mb-4 max-w-2xl font-grimoire text-[clamp(26px,4.2vw,38px)] font-medium leading-[1.12] text-bone">
            What it can’t see — and what it still does.
          </h2>
          <p className="mb-12 max-w-[62ch] text-[16px] leading-7 text-ash">
            A trust document that hides its weaknesses is worthless. So here is the whole ledger,
            not the flattering half.
          </p>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="rounded-md border border-line-g bg-char p-7">
              <div className="mb-4 flex items-center gap-3">
                <EyeOff className="size-5 text-hellfire" aria-hidden />
                <h3 className="font-sigil text-[12px] tracking-[0.2em] text-ember uppercase">
                  Cannot see
                </h3>
              </div>
              <ul className="space-y-3 text-[15px] leading-7 text-bone">
                <LedgerItem>Your terminal input, output, and scrollback</LedgerItem>
                <LedgerItem>The contents of any file on your hosts</LedgerItem>
                <LedgerItem>What your agents are actually doing</LedgerItem>
                <LedgerItem>Your API keys or agent logins — it never has them</LedgerItem>
              </ul>
            </div>
            <div className="rounded-md border border-line-g bg-char p-7">
              <div className="mb-4 flex items-center gap-3">
                <Eye className="size-5 text-ash" aria-hidden />
                <h3 className="font-sigil text-[12px] tracking-[0.2em] text-ash uppercase">
                  Still sees (the metadata)
                </h3>
              </div>
              <ul className="space-y-3 text-[15px] leading-7 text-ash">
                <LedgerItem tone="ash">Which hosts you own and when they’re online</LedgerItem>
                <LedgerItem tone="ash">That an agent stirred — never what it said</LedgerItem>
                <LedgerItem tone="ash">Connection timing and approximate volume</LedgerItem>
                <LedgerItem tone="ash">
                  Self-host the whole stack if even this is too much
                </LedgerItem>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Fingerprint verification */}
      <section className="border-line-g border-b px-5 py-20 sm:px-8">
        <div className="mx-auto grid w-full max-w-5xl gap-10 lg:grid-cols-[1fr_1fr] lg:items-center">
          <div>
            <p className="mb-3 font-sigil text-[12px] tracking-[0.3em] text-hellfire uppercase">
              Deaf, and blind to tampering
            </p>
            <h2 className="mb-6 font-grimoire text-[clamp(24px,3.8vw,34px)] font-medium leading-[1.15] text-bone">
              Verify the fingerprint. Refuse the impostor.
            </h2>
            <p className="max-w-[56ch] text-[16px] leading-8 text-ash">
              Every connection is signed by endpoint identity keys and pinned on first contact. A
              hostile relay that tries to substitute a key to wiretap the handshake is caught: the
              daemon prints its fingerprint, you compare it once, and a changed fingerprint is
              refused, loudly. It’s the tailnet-lock model — trust the endpoints, not the
              introducer.
            </p>
          </div>
          <div className="rounded-md border border-line-g bg-char p-8 font-sigil text-[13px] leading-7">
            <p className="text-ash"># spawnd status</p>
            <p className="mt-3 flex items-center gap-2 text-bone">
              <Fingerprint className="size-4 text-hellfire" aria-hidden /> host{" "}
              <span className="text-hellfire">dream</span>
            </p>
            <p className="text-bone">
              fingerprint <span className="text-ember">4f:9a:c3:e1:0b:77:d2:5c…</span>
            </p>
            <p className="mt-3 text-hellfire">signed offer verified against local pin ✓</p>
            <p className="text-bone">this session is yours alone.</p>
          </div>
        </div>
      </section>

      {/* The turn / CTA */}
      <section className="relative overflow-hidden px-5 py-24 sm:px-8">
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 70% 55% at 50% 120%, rgba(142,31,22,.4), transparent 62%)",
          }}
        />
        <div className="relative mx-auto w-full max-w-3xl text-center">
          <Flame className="mx-auto mb-6 size-8 text-hellfire" aria-hidden />
          <h2 className="mb-6 font-grimoire text-[clamp(26px,4.4vw,40px)] font-medium leading-[1.12] text-bone">
            The scarier it sounds, the safer it is.
          </h2>
          <p className="mx-auto mb-9 max-w-[60ch] text-[17px] leading-8 text-ash">
            A daemon that dials out and answers to one master sounds ominous — until you notice who
            the master is. You installed it. You approved it against a key you can see. And you can
            inspect everything it can’t: the source is open, and the threat model names our own
            servers as the adversary. Don’t take our word for it — read it.
          </p>
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/signup"
              className="group inline-flex items-center justify-center gap-2 rounded-sm bg-hellfire px-7 py-3.5 font-sigil text-[13px] tracking-[0.14em] text-void uppercase transition-colors hover:bg-ember"
            >
              Sign up
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/download"
              className="inline-flex items-center justify-center gap-2 rounded-sm border border-line-strong px-7 py-3.5 font-sigil text-[13px] tracking-[0.14em] text-bone uppercase transition-colors hover:border-ember hover:text-ember"
            >
              Install the daemon
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-line-g border-t px-5 py-10 sm:px-8">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-center font-sigil text-[12px] tracking-[0.08em] text-ash">
          <span>
            <span className="text-hellfire">spawnd</span> · consensual · auditable · revocable
          </span>
        </div>
      </footer>
    </main>
  );
}

function Mechanism({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-void p-7">
      <div className="mb-4 flex size-10 items-center justify-center rounded-sm border border-hellfire/40 text-hellfire">
        {icon}
      </div>
      <h3 className="mb-2 font-grimoire text-[19px] font-medium text-bone">{title}</h3>
      <p className="text-[15px] leading-7 text-ash">{children}</p>
    </div>
  );
}

function LedgerItem({ children, tone }: { children: ReactNode; tone?: "ash" }) {
  return (
    <li className="flex items-start gap-3">
      <Flame
        className={`mt-1 size-3 shrink-0 ${tone === "ash" ? "text-ash" : "text-hellfire"}`}
        aria-hidden
      />
      <span>{children}</span>
    </li>
  );
}
