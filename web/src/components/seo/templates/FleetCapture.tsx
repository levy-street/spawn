import Image from "next/image";
import { RefTag } from "@/components/seo/templates/JobPage";

/*
 * The one product capture a job page shows: a real workspace recorded from
 * the live app, framed quietly and captioned as an example. It supports the
 * page's general claim — the copy around it never narrates its tiles. The
 * video is decoration over the poster (same frame, in motion), so
 * reduced-motion readers get the still and lose nothing. Server component;
 * the video attributes do all the work.
 */

const WIDTH = 1600;
const HEIGHT = 1020;

const ALT =
  "The spawnd app: a sidebar of workspaces and hosts beside a grid of live terminal sessions running CLI agents across three machines, switching between workspaces";

export function FleetCapture({ caption, refId }: { caption: string; refId?: string }) {
  return (
    <figure id={refId} className="relative min-w-0 scroll-mt-24">
      {refId ? <RefTag id={refId} /> : null}
      <div className="overflow-hidden rounded-xl bg-void ring-1 ring-line-g">
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
          aria-label={ALT}
        >
          <source src="/product/fleet-grid.mp4" type="video/mp4" />
        </video>
        <Image
          className="hidden h-auto w-full motion-reduce:block"
          src="/product/fleet-grid.png"
          width={WIDTH}
          height={HEIGHT}
          alt={ALT}
        />
      </div>
      <figcaption className="mt-3 text-[13px] leading-6 text-ash">{caption}</figcaption>
    </figure>
  );
}
