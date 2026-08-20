import { ArrowRight, Eye, EyeOff, Fingerprint, Flame, Lock, Network, Server } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  Colophon,
  CTA_QUIET,
  CTA_SLAB,
  Eyebrow,
  Masthead,
  RegistrationMarks,
} from "@/components/brand/press";
import { Wordmark } from "@/components/icons/BrandMark";
import { poster } from "@/lib/fonts";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Security — the server that can't read your terminal",
  description:
    "spawnd's control plane introduces your browser to the daemon, then goes deaf. Terminal I/O is end-to-end encrypted browser-to-daemon; the relay, when your network forces one, carries only ciphertext. The threat model names our own servers as the adversary.",
};

export default function SecurityPage() {
  return (
    <main className="grimoire min-h-vv overflow-x-clip">
      <Masthead current="security" />

      {/* ── The hero, struck on the press bed ──────────────────── */}
      <header className="relative isolate overflow-hidden border-line-g border-b px-5 py-24 sm:px-8">
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 60% 55% at 50% 0%, rgba(225,30,21,.12), transparent 60%)",
          }}
        />
        <RegistrationMarks />
        <div className="relative z-10 mx-auto w-full max-w-3xl text-center">
          <Eyebrow className="mb-5">Security</Eyebrow>
          <h1
            className={cn(
              poster.className,
              "mb-6 text-[clamp(36px,6.9vw,65px)] leading-[1.02] font-light text-bone uppercase [text-wrap:balance]",
            )}
          >
            We introduce. <em className="text-hellfire not-italic">We never listen.</em>
          </h1>
          <p className="mx-auto max-w-[58ch] text-[17px] leading-8 text-ash">
            The control plane exists to bring your browser and your daemon into the same room. The
            moment they shake hands, it goes deaf. The distinction we build to:{" "}
            <em className="text-bone not-italic">the server cannot read your terminal</em> — not “we
            don’t look,” but “we can’t.”
          </p>
        </div>
      </header>

      {/* ── The governing principle ────────────────────────────── */}
      <section className="border-line-g border-b px-5 py-20 sm:px-8">
        <div className="mx-auto w-full max-w-3xl">
          <blockquote
            className={cn(
              poster.className,
              "border-hellfire border-l-2 pl-6 text-[clamp(24px,3.7vw,35px)] leading-[1.3] text-bone italic",
            )}
          >
            “The only parties that handle your terminal are the daemon on your host and the browser
            in your hand. The server introduces them; it never sees the conversation.”
          </blockquote>
          <p className="mt-6 pl-6 font-sigil text-[11px] tracking-[0.18em] text-ash uppercase">
            — the governing principle, verbatim from the threat model
          </p>
        </div>
      </section>

      {/* ── Plate II: the mechanism, black ink on red ──────────── */}
      <section className="relative overflow-hidden bg-plate text-void">
        {/* The stamp, rotated off the plate's corner. Kept small and faint, and
         * pulled well clear of the columns: at 20% it darkens the ground it
         * sits on, and black body copy over that dimmed red stops reading. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-20 -right-20 size-[16rem] rotate-[4deg] opacity-[0.10] sm:size-[22rem]"
        >
          {/* biome-ignore lint/performance/noImgElement: decorative stamp, no optimization needed */}
          <img src="/brand/spawnd-icon-black.svg" alt="" className="size-full" />
        </div>
        <div className="relative mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
          <p className="mb-5 font-sigil text-[12px] font-medium tracking-[0.3em] uppercase">
            How the server stays deaf
          </p>
          <h2
            className={cn(
              poster.className,
              "mb-14 max-w-[20ch] text-[clamp(30px,4.8vw,52px)] leading-[1.0] font-light uppercase",
            )}
          >
            End-to-end encrypted, browser to daemon.
          </h2>
          <div className="grid min-w-0 gap-y-12 sm:grid-cols-2 sm:gap-x-12 lg:gap-x-16">
            <Mechanism icon={<Network className="size-4" />} title="Direct channels">
              Terminal input, output, and scrollback ride encrypted WebRTC DataChannels negotiated
              directly between the two endpoints. The keys live at the endpoints; the server holds
              none of them.
            </Mechanism>
            <Mechanism icon={<EyeOff className="size-4" />} title="Signaling only">
              The control plane carries auth, lifecycle, and the introduction handshake. There is no
              server code path for terminal content, no transcript store, nothing to hand over.
            </Mechanism>
            <Mechanism icon={<Lock className="size-4" />} title="Ciphertext relay, as a fallback">
              A relay is used only when NAT leaves no direct path. It then forwards opaque
              ciphertext it can’t decrypt — reachability without disclosure.
            </Mechanism>
            <Mechanism icon={<Server className="size-4" />} title="Outbound-only hosts">
              The daemon dials out and holds the line. No inbound ports, no exposed SSH, no tailnet.
              Nothing reaches in; the daemon only reaches out.
            </Mechanism>
          </div>
        </div>
      </section>

      {/* ── The honest ledger ──────────────────────────────────── */}
      <section className="border-line-g border-b px-5 py-24 sm:px-8">
        <div className="mx-auto w-full max-w-6xl">
          <Eyebrow className="mb-5">The honest ledger</Eyebrow>
          <h2
            className={cn(
              poster.className,
              "mb-5 max-w-[20ch] text-[clamp(30px,4.5vw,48px)] leading-[1.02] font-light text-bone uppercase",
            )}
          >
            What it can’t see — and what it still does.
          </h2>
          <p className="mb-14 max-w-[62ch] text-[17px] leading-8 text-ash">
            A trust document that hides its weaknesses is worthless. So here is the whole ledger,
            not the flattering half.
          </p>
          <div className="grid min-w-0 gap-6 md:grid-cols-2">
            <div className="rounded-sm border border-line-strong bg-char p-7 sm:p-8">
              <div className="mb-6 flex items-center gap-3 border-line-g border-b pb-4">
                <EyeOff className="size-4 text-hellfire" aria-hidden />
                <h3 className="font-sigil text-[11px] tracking-[0.22em] text-ember uppercase">
                  Cannot see
                </h3>
              </div>
              <ul className="space-y-3.5 text-[15px] leading-7 text-bone">
                <LedgerItem>Your terminal input, output, and scrollback</LedgerItem>
                <LedgerItem>The contents of any file on your hosts</LedgerItem>
                <LedgerItem>What your agents are actually doing</LedgerItem>
                <LedgerItem>Your API keys or agent logins — it never has them</LedgerItem>
              </ul>
            </div>
            <div className="rounded-sm border border-line-strong bg-char p-7 sm:p-8">
              <div className="mb-6 flex items-center gap-3 border-line-g border-b pb-4">
                <Eye className="size-4 text-ash" aria-hidden />
                <h3 className="font-sigil text-[11px] tracking-[0.22em] text-ash uppercase">
                  Still sees (the metadata)
                </h3>
              </div>
              <ul className="space-y-3.5 text-[15px] leading-7 text-ash">
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

      {/* ── Fingerprint verification ───────────────────────────── */}
      <section className="border-line-g border-b px-5 py-24 sm:px-8">
        <div className="mx-auto grid w-full max-w-6xl min-w-0 gap-14 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
          <div>
            <Eyebrow className="mb-5">Deaf, and blind to tampering</Eyebrow>
            <h2
              className={cn(
                poster.className,
                "mb-6 max-w-[17ch] text-[clamp(28px,3.7vw,48px)] leading-[1.04] font-light text-bone uppercase",
              )}
            >
              Verify the fingerprint. Refuse the impostor.
            </h2>
            <p className="max-w-[56ch] text-[17px] leading-8 text-ash">
              Every connection is signed by endpoint identity keys and pinned on first contact. A
              hostile relay that tries to substitute a key to wiretap the handshake is caught: the
              daemon prints its fingerprint, you compare it once, and a changed fingerprint is
              refused, loudly. It’s the tailnet-lock model — trust the endpoints, not the
              introducer.
            </p>
          </div>
          {/* The same plate the lander sets "the server's entire view" on. */}
          <figure className="min-w-0 border border-line-strong bg-char">
            <figcaption className="flex items-center justify-between gap-4 border-line-g border-b px-5 py-3.5 font-sigil text-[11px] tracking-[0.22em] text-ash uppercase">
              <span>Pinned on first contact</span>
              <span aria-hidden className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-hellfire" />
                <span className="size-2 rounded-full bg-blood" />
                <span className="size-2 rounded-full bg-line-strong" />
              </span>
            </figcaption>
            <div className="min-w-0 space-y-2.5 overflow-x-auto px-5 py-6 font-sigil text-[12px] leading-6 text-bone sm:px-6 sm:text-[13px]">
              <p className="whitespace-nowrap">
                <span className="text-ember">$</span> spawnd status
              </p>
              <p className="flex items-center gap-2 whitespace-nowrap">
                <Fingerprint className="size-4 shrink-0 text-hellfire" aria-hidden /> host{" "}
                <span className="text-hellfire">dream</span>
              </p>
              <p className="whitespace-nowrap">
                <span className="text-ash">fingerprint</span>{" "}
                <span className="text-ember">4f:9a:c3:e1:0b:77:d2:5c…</span>
              </p>
              <p className="whitespace-nowrap pt-3 text-hellfire">
                signed offer verified against local pin ✓
              </p>
              <p className="whitespace-nowrap">this session is yours alone.</p>
            </div>
          </figure>
        </div>
      </section>

      {/* ── The turn: the closing poster ───────────────────────── */}
      <section className="relative isolate overflow-hidden">
        <Image
          src="/brand/ink/altar-ink.png"
          alt=""
          aria-hidden
          fill
          sizes="100vw"
          className="pointer-events-none object-cover object-[50%_38%]"
        />
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(0,0,0,.98) 0%, rgba(0,0,0,.9) 34%, rgba(0,0,0,.62) 62%, rgba(0,0,0,.82) 100%)",
          }}
        />
        <div className="relative z-10 mx-auto w-full max-w-3xl px-5 pt-32 pb-20 text-center sm:px-8">
          {/* A measure narrow enough that the line breaks after the comma, so
           * the turn lands as two balanced halves rather than a stranded "is." */}
          <h2
            className={cn(
              poster.className,
              "mx-auto mb-6 max-w-[14ch] text-[clamp(32px,5.6vw,63px)] leading-[1.0] font-light text-bone uppercase [text-wrap:balance]",
            )}
          >
            The scarier it sounds, <em className="text-hellfire not-italic">the safer it is.</em>
          </h2>
          <p className="mx-auto mb-10 max-w-[60ch] text-[17px] leading-8 text-ash">
            A daemon that dials out and answers to one master sounds ominous — until you notice who
            the master is. You installed it. You approved it against a key you can see. And you can
            inspect everything it can’t: the source is open, and the threat model names our own
            servers as the adversary. Don’t take our word for it — read it.
          </p>
          <div className="flex flex-col items-center justify-center gap-5 sm:flex-row sm:gap-7">
            <Link href="/signup" className={CTA_SLAB}>
              Sign up
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link href="/download" className={CTA_QUIET}>
              Install the daemon
            </Link>
          </div>
        </div>

        {/* The drawn wordmark at full plate width, closing the sheet. */}
        <div className="relative z-10 px-2 pt-16 sm:px-3">
          <Wordmark aria-hidden className="block w-full text-hellfire" />
        </div>
      </section>

      <Colophon />
    </main>
  );
}

/**
 * One mechanism on the red plate, set the way the lander's rites are: a rule
 * across the top, the poster face in caps, and serif body beneath.
 */
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
    <div className="border-t-2 border-void pt-6">
      <div className="mb-3 flex items-center gap-3">
        <span aria-hidden className="shrink-0">
          {icon}
        </span>
        <h3 className={cn(poster.className, "text-[24px] leading-[1.08] font-light uppercase")}>
          {title}
        </h3>
      </div>
      <p className="max-w-[44ch] text-[16px] leading-7">{children}</p>
    </div>
  );
}

function LedgerItem({ children, tone }: { children: ReactNode; tone?: "ash" }) {
  return (
    <li className="flex items-start gap-3">
      <Flame
        className={cn("mt-1.5 size-3 shrink-0", tone === "ash" ? "text-ash" : "text-hellfire")}
        aria-hidden
      />
      <span>{children}</span>
    </li>
  );
}
