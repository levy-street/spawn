import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppProviders } from "@/lib/query";
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
  themeColor: "#000000",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-background text-foreground antialiased">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
