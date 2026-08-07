import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppProviders } from "@/lib/query";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme-bootstrap";
import "./globals.css";

export const metadata: Metadata = {
  title: "spawn",
  description: "Multi-tenant control plane for CLI coding agents.",
  applicationName: "spawn",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "spawn",
    statusBarStyle: "black-translucent",
  },
  icons: {
    // SVG first: browsers that support it scale the mark crisply at any tab
    // size, where the PNG's maskable padding would leave it small and soft.
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
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
  themeColor: "#070707",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the bootstrap script below stamps data-theme
    // and color-scheme onto <html> before React sees it, so the server markup
    // is expected to differ here.
    <html lang="en" suppressHydrationWarning>
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
