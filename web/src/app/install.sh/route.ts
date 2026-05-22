import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_REPO = "https://github.com/levy-street/spawn.git";
const DEFAULT_BRANCH = "master";
const REPO_ROOT = path.resolve(process.cwd(), "..");
const TEMPLATE_PATH = path.join(process.cwd(), "src", "app", "install.sh", "install-template.sh");

let cachedTemplate: string | null = null;

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const publicUrl = process.env.SPAWN_PUBLIC_URL?.trim() || requestOrigin(request);
  const script = installTemplate()
    .replaceAll("__DEFAULT_SERVER__", shQuote(publicUrl.replace(/\/+$/, "")))
    .replaceAll("__DEFAULT_REPO__", shQuote(defaultRepo()))
    .replaceAll("__DEFAULT_BRANCH__", shQuote(defaultBranch()));

  return new Response(script, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/x-shellscript; charset=utf-8",
    },
  });
}

function installTemplate() {
  cachedTemplate ??= readFileSync(TEMPLATE_PATH, "utf8");
  return cachedTemplate;
}

function defaultRepo() {
  if (process.env.SPAWN_INSTALL_REPO) return process.env.SPAWN_INSTALL_REPO;
  if (process.env.NODE_ENV !== "production") return pathToFileURL(REPO_ROOT).href;
  return DEFAULT_REPO;
}

function defaultBranch() {
  if (process.env.SPAWN_INSTALL_BRANCH) return process.env.SPAWN_INSTALL_BRANCH;
  if (process.env.NODE_ENV === "production") return DEFAULT_BRANCH;

  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch && branch !== "HEAD" ? branch : DEFAULT_BRANCH;
  } catch {
    return DEFAULT_BRANCH;
  }
}

function requestOrigin(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || url.host;
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    url.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

function shQuote(value: string) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
