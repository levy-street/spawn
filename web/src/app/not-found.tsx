import type { Metadata } from "next";
import { ErrorSurface } from "@/components/brand/error-surface";

export const metadata: Metadata = {
  title: "Page not found",
};

export default function NotFound() {
  return (
    <ErrorSurface
      status="404"
      eyebrow="Misprint"
      title="Nothing lives at this address"
      description="The page may have moved, or the link was cut short. Your machines and sessions are untouched."
    />
  );
}
