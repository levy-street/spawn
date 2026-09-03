import type { MetadataRoute } from "next";

/**
 * Crawlers get the marketing surfaces, the grimoire pages, the tools, and
 * the docs; the signed-in app, auth ceremonies, and internal demos are not
 * for indexing. /signup stays crawlable on purpose — it is the conversion
 * target every public page points at.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/admin",
          "/app",
          "/device",
          "/forgot-password",
          "/hosts",
          "/legion",
          "/login",
          "/onboarding",
          "/reset-password",
          "/sessions",
          "/trust-ux-demo",
          "/verify-email",
          "/w",
        ],
      },
    ],
    sitemap: "https://spawnd.dev/sitemap.xml",
  };
}
