import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { grimoire } from "@/lib/fonts";
import { AppProviders } from "@/lib/query";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme-bootstrap";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://spawnd.dev"),
  title: {
    default: "SPAWN D - Host your daemons",
    template: "%s · SPAWN D",
  },
  description:
    "The open-source control plane for CLI coding agents. A daemon on every host you own — summon your agents, reach them from any browser, and the server that connects you never hears a word.",
  applicationName: "SPAWN D",
  manifest: "/manifest.webmanifest",
  openGraph: {
    title: "SPAWN D — a daemon on every host you own",
    description:
      "A daemon on every host you own. Summon coding agents, reach them from any browser — the server that connects you never hears a word.",
    url: "https://spawnd.dev",
    siteName: "SPAWN D",
    images: [{ url: "/og.jpg", width: 1200, height: 630 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "SPAWN D — a daemon on every host you own",
    description:
      "A daemon on every host you own. The server that connects you can't read your terminal.",
    images: ["/og.jpg"],
  },
  appleWebApp: {
    capable: true,
    title: "SPAWN D",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/favicon-48.png", sizes: "48x48", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  // A single tag rather than a light/dark media pair: an explicit theme choice
  // has to beat the OS preference, and only script can express that. applyTheme
  // rewrites this on load and on every change.
  themeColor: "#000000",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the bootstrap script below stamps data-theme
    // and color-scheme onto <html> before React sees it, so the server markup
    // is expected to differ here.
    // The body face rides along as a CSS variable on <html>: the @theme token
    // --font-grimoire substitutes var(--font-plex-sans) at :root, so the
    // variable has to live on the root element itself to resolve.
    <html lang="en" suppressHydrationWarning className={grimoire.variable}>
      <head>
        {/* Must run before first paint; see lib/theme-bootstrap.ts. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: fixed, build-time string with no interpolation */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="bg-background text-foreground antialiased">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
