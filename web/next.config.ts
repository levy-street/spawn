import path from "node:path";
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

function defaultPublicWsUrl(): string {
  if (process.env.NEXT_PUBLIC_SPAWN_WS_URL !== undefined) {
    return process.env.NEXT_PUBLIC_SPAWN_WS_URL;
  }
  return "";
}

// Next mints a random buildId per build, which bakes a different string into
// every prerendered .html/.rsc and renames static/<buildId>/. That alone makes
// the client unverifiable: nobody can rebuild a commit and check it matches
// what a server serves. Pinning it takes the served surface from 28
// nondeterministic files to zero. Callers wanting cache-busting across commits
// set SPAWN_BUILD_ID to the commit sha, and the verifier passes the same sha.
function buildId(): string {
  return process.env.SPAWN_BUILD_ID || "spawn";
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep Next rooted in this workspace even when a parent directory contains
  // an unrelated npm lockfile.
  outputFileTracingRoot: path.resolve(process.cwd()),
  generateBuildId: buildId,
  experimental: {
    // Next buffers proxied request bodies (rewrites share the middleware
    // pipeline) with a 10MB default, silently truncating larger uploads. The
    // file explorer allows 32MB files; leave headroom.
    middlewareClientMaxBodySize: 64 * 1024 * 1024,
  },
  env: {
    NEXT_PUBLIC_SPAWN_BUILD_ID: buildId(),
    NEXT_PUBLIC_SPAWN_WS_URL: defaultPublicWsUrl(),
  },
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
      { source: "/install.sh", destination: `${API_PROXY_TARGET}/install.sh` },
    ];
  },
  // The overhaul collapsed five nav destinations into one workspace page plus a
  // settings modal. These keep bookmarks and daemon-printed links from 404ing;
  // an agent id still resolves because agents became sessions one-for-one.
  async redirects() {
    return [
      // Order matters: the literal /agents/new must precede /agents/:id, or the
      // dynamic rule swallows it and sends it to a session that cannot exist.
      { source: "/agents/new", destination: "/", permanent: false },
      { source: "/agents/:id", destination: "/sessions/:id", permanent: false },
      { source: "/agents", destination: "/", permanent: false },
      { source: "/screens", destination: "/", permanent: false },
      { source: "/screens/:id", destination: "/w/:id", permanent: false },
      { source: "/presets", destination: "/", permanent: false },
      { source: "/hosts", destination: "/", permanent: false },
      { source: "/settings", destination: "/", permanent: false },
      { source: "/trust", destination: "/", permanent: false },
    ];
  },
};

export default nextConfig;
