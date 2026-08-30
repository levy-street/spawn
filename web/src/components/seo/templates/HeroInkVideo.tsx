"use client";

import { useEffect, useState } from "react";

/**
 * The hero ink, in motion — loaded only after the window finishes, so the
 * poster wins LCP and the film arrives as decoration. Half speed so the
 * print breathes; reduced-motion readers get the poster via the
 * server-rendered fallback beside it.
 */
export function HeroInkVideo({ video, poster }: { video: string; poster: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (document.readyState === "complete") {
      setReady(true);
      return;
    }
    const arm = () => setReady(true);
    window.addEventListener("load", arm, { once: true });
    return () => window.removeEventListener("load", arm);
  }, []);
  return (
    <video
      className="pointer-events-none absolute inset-0 h-full w-full object-cover motion-reduce:hidden"
      autoPlay
      muted
      loop
      playsInline
      preload="none"
      onLoadedMetadata={(event) => {
        event.currentTarget.playbackRate = 0.5;
      }}
      poster={poster}
    >
      {ready ? <source src={video} type="video/mp4" /> : null}
    </video>
  );
}
