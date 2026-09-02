"use client";

// A root error boundary replaces the root layout wholesale and inherits none
// of its styles, so the sheet the layout imports has to be imported here too —
// without it the production build renders this page with no CSS at all and
// the altar ink paints over the copy.
import "./globals.css";
import { ERROR_ACTION_CLASS, ErrorSurface } from "@/components/brand/error-surface";
import { grimoire } from "@/lib/fonts";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className={grimoire.variable}>
      <head>
        <title>Something went wrong · SPAWN D</title>
      </head>
      <body className="bg-background text-foreground antialiased">
        <ErrorSurface
          status="500"
          eyebrow="Press fault"
          title="The press stopped"
          description="SPAWN D hit a problem before the page could open. Your machines and running sessions are still there."
          action={
            <button type="button" className={ERROR_ACTION_CLASS} onClick={reset}>
              Try again
            </button>
          }
        />
      </body>
    </html>
  );
}
