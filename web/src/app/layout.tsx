import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppProviders } from "@/lib/query";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme-bootstrap";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://spawnd.dev"),
  title: {
    default: "spawnd — possess your machines",
    template: "%s · spawnd",
  },
  description:
    "The open-source control plane that possesses every machine you own with a single daemon. Summon, drive, and banish CLI coding agents from any browser — while the server that coordinates it all is structurally unable to read your terminal.",
  applicationName: "spawnd",
  manifest: "/manifest.webmanifest",
  openGraph: {
    title: "spawnd — possess your machines",
    description:
      "A daemon on every host you own. Summon CLI coding agents from any browser. The server can't read your terminal — cryptography, not policy.",
    url: "https://spawnd.dev",
    siteName: "spawnd",
    images: [{ url: "/possession.png", width: 1280, height: 720 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "spawnd — possess your machines",
    description:
      "A daemon on every host you own. The server can't read your terminal — cryptography, not policy.",
    images: ["/possession.png"],
  },
  appleWebApp: {
    capable: true,
    title: "spawnd",
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
  themeColor: "#0A0607",
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
