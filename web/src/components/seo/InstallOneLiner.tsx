"use client";

import { useEffect, useState } from "react";
import { InstallCommand } from "@/components/brand/press";

/**
 * The install chip with the landing page's origin dance: canonical domain in
 * the server-rendered HTML (what crawlers index), the live origin once
 * hydrated (what a dev-instance visitor should actually paste).
 */
export function InstallOneLiner({ className }: { className?: string }) {
  const [origin, setOrigin] = useState("https://spawnd.dev");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  return <InstallCommand command={`curl -fsSL ${origin}/install.sh | sh`} className={className} />;
}
