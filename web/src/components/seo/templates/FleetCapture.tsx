import Image from "next/image";
import { CaptureVideo } from "@/components/seo/templates/CaptureVideo";
import { RefTag } from "@/components/seo/templates/JobPage";

/*
 * The one product capture a job page shows: a real workspace recorded from
 * the live app, framed quietly and captioned as an example. It supports the
 * page's general claim — the copy around it never narrates its tiles. The
 * still is the in-flow frame (lazy, responsive); the recording overlays it
 * once the reader nears, so nothing here weighs on first paint and
 * reduced-motion readers keep the identical still.
 */

const WIDTH = 1600;
const HEIGHT = 1020;

const ALT =
  "The spawnd app: a sidebar of workspaces and hosts beside a grid of live terminal sessions running CLI agents across three machines, switching between workspaces";

export function FleetCapture({ caption, refId }: { caption: string; refId?: string }) {
  return (
    <figure id={refId} className="relative min-w-0 scroll-mt-24">
      {refId ? <RefTag id={refId} /> : null}
      <div className="relative overflow-hidden rounded-xl bg-void ring-1 ring-line-g">
        <Image
          className="block h-auto w-full"
          src="/product/fleet-grid.png"
          sizes="(min-width: 1024px) 64rem, 100vw"
          width={WIDTH}
          height={HEIGHT}
          alt={ALT}
        />
        <CaptureVideo src="/product/fleet-grid.mp4" label={ALT} />
      </div>
      <figcaption className="mt-3 text-[13px] leading-6 text-ash">{caption}</figcaption>
    </figure>
  );
}
