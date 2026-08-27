"use client";

/**
 * The hero ink, in motion. The one client concern in the hero: slowing the
 * loop to half speed so the print breathes instead of flickering — which
 * needs an event handler, so this island exists. Reduced-motion readers get
 * the poster via the server-rendered fallback beside it.
 */
export function HeroInkVideo({ video, poster }: { video: string; poster: string }) {
  return (
    <video
      className="pointer-events-none absolute inset-0 h-full w-full object-cover motion-reduce:hidden"
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      onLoadedMetadata={(event) => {
        event.currentTarget.playbackRate = 0.5;
      }}
      poster={poster}
    >
      <source src={video} type="video/mp4" />
    </video>
  );
}
