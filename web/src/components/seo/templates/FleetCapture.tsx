import Image from "next/image";

/*
 * The job template's signature: a live capture of the actual product — a
 * six-tile workspace across three possessed hosts, recorded from the real
 * app. The video is decoration over the poster (same frame, in motion), so
 * reduced-motion readers get the still and lose nothing. Server component;
 * the video attributes do all the work.
 */

const WIDTH = 1540;
const HEIGHT = 950;

export function FleetCapture({ caption = "the-fleet — six sessions · dream / rig / mini" }) {
  return (
    <figure className="min-w-0 border border-line-strong bg-char">
      <figcaption className="flex items-center justify-between gap-4 border-line-g border-b px-5 py-3.5 font-sigil text-[11px] tracking-[0.22em] text-ash uppercase">
        <span className="truncate">{caption}</span>
        <span className="hidden shrink-0 items-center gap-2 sm:flex">
          <span aria-hidden className="size-2 rounded-full bg-hellfire" />
          <span>Live capture</span>
        </span>
      </figcaption>
      {/* Motion-safe: the recording. Reduced motion: the identical still. */}
      <video
        className="block h-auto w-full motion-reduce:hidden"
        width={WIDTH}
        height={HEIGHT}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        poster="/product/fleet-grid.png"
        aria-label="A spawnd workspace: six live terminal tiles across three hosts — Claude Code holding a permission prompt, Codex streaming a diff, a test suite accumulating passes"
      >
        <source src="/product/fleet-grid.mp4" type="video/mp4" />
      </video>
      <Image
        className="hidden h-auto w-full motion-reduce:block"
        src="/product/fleet-grid.png"
        width={WIDTH}
        height={HEIGHT}
        alt="A spawnd workspace: six live terminal tiles across three hosts — Claude Code holding a permission prompt, Codex streaming a diff, a test suite accumulating passes"
      />
    </figure>
  );
}
