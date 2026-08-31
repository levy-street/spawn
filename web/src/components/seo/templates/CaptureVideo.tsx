"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The motion layer of a product capture. An autoplay video overrides
 * preload="metadata" and fetches whole megabytes at page load, so the film
 * mounts only when the reader nears it — the server-rendered still underneath
 * holds the frame until then, and holds it forever for reduced-motion readers.
 */
export function CaptureVideo({ src, label }: { src: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!window.matchMedia("(prefers-reduced-motion: no-preference)").matches) {
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setArmed(true);
          io.disconnect();
        }
      },
      { rootMargin: "25% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} aria-hidden={!armed} className="pointer-events-none absolute inset-0">
      {armed ? (
        <video
          className="h-full w-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          aria-label={label}
        >
          <source src={src} type="video/mp4" />
        </video>
      ) : null}
    </div>
  );
}
