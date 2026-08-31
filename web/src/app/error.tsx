"use client";

import { ERROR_ACTION_CLASS, ErrorSurface } from "@/components/brand/error-surface";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorSurface
      status="500"
      eyebrow="Press fault"
      title="This page jammed"
      description="SPAWN D hit a problem while loading this page. Your machines and running sessions are still there."
      action={
        <button type="button" className={ERROR_ACTION_CLASS} onClick={reset}>
          Try again
        </button>
      }
    />
  );
}
