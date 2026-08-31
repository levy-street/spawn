"use client";

import { useEffect, useState } from "react";

/**
 * The hero ink, in motion — decoration over the server-rendered still, so it
 * never competes with the page. It waits for the window to finish loading,
 * and only desktop viewports that allow motion fetch it at all: a phone gets
 * the still and saves the megabytes. Half speed so the print breathes.
 */
export function HeroInkVideo({ video }: { video: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const wanted = window.matchMedia(
      "(min-width: 768px) and (prefers-reduced-motion: no-preference)",
    );
    if (!wanted.matches) return;
    if (document.readyState === "complete") {
      setReady(true);
      return;
    }
    const arm = () => setReady(true);
    window.addEventListener("load", arm, { once: true });
    return () => window.removeEventListener("load", arm);
  }, []);
  if (!ready) return null;
  return (
    <video
      className="pointer-events-none absolute inset-0 h-full w-full object-cover"
      autoPlay
      muted
      loop
      playsInline
      preload="none"
      onLoadedMetadata={(event) => {
        event.currentTarget.playbackRate = 0.5;
      }}
    >
      <source src={video} type="video/mp4" />
    </video>
  );
}
