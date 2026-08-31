import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { RegistrationMarks } from "@/components/brand/press";
import { Trident, Wordmark } from "@/components/icons/BrandMark";
import { poster } from "@/lib/fonts";
import { cn } from "@/lib/utils";

interface ErrorSurfaceProps {
  status: string;
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}

export const ERROR_ACTION_CLASS =
  "inline-flex min-h-11 items-center justify-center rounded-sm bg-bone px-6 py-3 font-sigil text-[12px] font-medium tracking-[0.14em] text-void uppercase transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember";

export function ErrorSurface({ status, eyebrow, title, description, action }: ErrorSurfaceProps) {
  return (
    <main className="grimoire pressroom relative isolate flex min-h-vv overflow-hidden bg-void px-5 py-10 text-bone sm:px-8">
      <Image
        src="/brand/ink/altar-ink.png"
        alt=""
        aria-hidden
        fill
        priority
        sizes="100vw"
        className="pointer-events-none -z-10 object-cover object-[50%_32%]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(0,0,0,.96)_0%,rgba(0,0,0,.84)_52%,rgba(0,0,0,.97)_100%)]"
      />
      <RegistrationMarks />

      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-between gap-16">
        <Link
          href="/"
          aria-label="SPAWN D home"
          className="flex min-h-11 w-fit items-center gap-3 text-hellfire transition-colors hover:text-ember focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
        >
          <Trident className="size-[26px]" />
          <Wordmark aria-hidden className="h-5" />
        </Link>

        <section className="grid items-end gap-8 border-line-g border-y py-8 sm:grid-cols-[minmax(0,0.7fr)_minmax(18rem,1.3fr)] sm:gap-12 sm:py-12">
          <p
            className={cn(
              poster.className,
              "text-[clamp(5rem,20vw,12rem)] leading-[0.72] font-light tracking-[-0.06em] text-hellfire",
            )}
            aria-hidden
          >
            {status}
          </p>
          <div className="max-w-xl">
            <p className="mb-5 font-sigil text-[11px] tracking-[0.28em] text-ember uppercase">
              {eyebrow}
            </p>
            <h1
              className={cn(
                poster.className,
                "text-[clamp(2rem,6vw,4rem)] leading-[1.02] font-light text-bone uppercase [text-wrap:balance]",
              )}
            >
              {title}
            </h1>
            <p className="mt-5 max-w-[54ch] text-[15px] leading-7 text-ash">{description}</p>
            <div className="mt-8 flex flex-wrap items-center gap-5">
              {action}
              <Link
                href="/"
                className={
                  action
                    ? "inline-flex min-h-11 items-center px-1 font-sigil text-[12px] tracking-[0.16em] text-bone uppercase underline decoration-ember/70 underline-offset-8 transition-colors hover:text-ember focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
                    : ERROR_ACTION_CLASS
                }
              >
                Back to SPAWN D
              </Link>
            </div>
          </div>
        </section>

        <p className="font-sigil text-[10px] tracking-[0.2em] text-ash uppercase">
          Your hosts keep running independently
        </p>
      </div>
    </main>
  );
}
