"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { LiveTerminalProvider } from "@/components/terminal/LiveTerminalProvider";
import { BrowserTrustProvider } from "@/lib/browser-trust";
import { useViewportInset } from "@/lib/viewport";

/**
 * Top-level providers that need to live inside the client tree.
 * Splits out the QueryClient creation to avoid sharing it between SSR
 * requests (we render mostly as a SPA anyway).
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  // Track keyboard / visualViewport for the modifier bar + terminal sizing.
  useViewportInset();

  // Register the service worker once, on the client.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;
    const onLoad = () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.warn("sw register failed", err);
      });
    };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });
    return () => window.removeEventListener("load", onLoad);
  }, []);

  return (
    <QueryClientProvider client={client}>
      <BrowserTrustProvider>
        <LiveTerminalProvider>{children}</LiveTerminalProvider>
      </BrowserTrustProvider>
    </QueryClientProvider>
  );
}
