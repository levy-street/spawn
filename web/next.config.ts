import type { NextConfig } from "next";

// Where the FastAPI server lives. Used for rewrites so /api/* and /ws/* go
// through Next's proxy and the deployed app is single-origin (no CORS, no
// cross-origin cookie weirdness over the tunnel).
const API_PROXY_TARGET =
  process.env.SPAWN_API_PROXY_TARGET ??
  (process.env.NODE_ENV === "production" ? "" : "http://localhost:8000");

if (!API_PROXY_TARGET) {
  throw new Error(
    "SPAWN_API_PROXY_TARGET is required for production builds/starts. Use `bun run build`/`bun run start`, or set it explicitly before invoking `next` directly.",
  );
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_PROXY_TARGET}/api/:path*` },
      { source: "/ws/:path*", destination: `${API_PROXY_TARGET}/ws/:path*` },
      { source: "/healthz", destination: `${API_PROXY_TARGET}/healthz` },
    ];
  },
};

export default nextConfig;
