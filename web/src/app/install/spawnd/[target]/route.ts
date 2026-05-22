import { execFile as execFileCallback } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { access, copyFile, mkdtemp, readdir, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

const REPO_ROOT = path.resolve(process.cwd(), "..");
const DEFAULT_ARTIFACT_DIR = path.join(REPO_ROOT, "dist", "spawnd");
const REL_PARENT = path.join(REPO_ROOT, "daemon", "_build", "default", "rel");
const REL_ROOT = path.join(REL_PARENT, "spawnd");
const RELEASE_BIN = path.join(REL_ROOT, "bin", "spawnd");
const RELEASE_CLI = path.join(REL_ROOT, "spawnd_cli");
const BUILT_CLI = path.join(REPO_ROOT, "daemon", "_build", "default", "bin", "spawnd");
const TARGET_PATTERN = /^(?:linux|darwin)-(?:x86_64|arm64)$/;
const execFile = promisify(execFileCallback);

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ target: string }> }) {
  const { target } = await params;
  const normalized = target.replace(/\.tar\.gz$/, "");

  if (!TARGET_PATTERN.test(normalized)) {
    return Response.json({ error: `unsupported daemon target: ${normalized}` }, { status: 404 });
  }

  const artifact = await configuredArtifact(normalized);
  if (artifact) {
    return artifactResponse(artifact, normalized);
  }

  const available = await availableTargets();
  if (normalized !== currentTarget()) {
    return Response.json(
      { error: `daemon artifact is not available for ${normalized}`, available },
      { status: 404 },
    );
  }

  if (!(await exists(RELEASE_BIN))) {
    return Response.json(
      {
        error:
          "daemon release is not built; run `cd daemon && rebar3 release && rebar3 escriptize`",
      },
      { status: 404 },
    );
  }

  const cliError = await ensureReleaseCli();
  if (cliError) {
    return Response.json({ error: cliError }, { status: 404 });
  }

  const archive = await packageCurrentRelease();
  if ("error" in archive) {
    return Response.json({ error: archive.error }, { status: 500 });
  }
  return artifactResponse(archive.file, normalized, true);
}

async function packageCurrentRelease() {
  const dir = await mkdtemp(path.join(tmpdir(), "spawn-daemon-"));
  const file = path.join(dir, "spawnd.tar.gz");
  try {
    await execFile("tar", ["-czf", file, "-C", REL_PARENT, "spawnd"]);
    return { file };
  } catch (error) {
    await unlink(file).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    return {
      error: `could not package daemon release: ${message}`,
    };
  }
}

async function configuredArtifact(target: string) {
  const dir = artifactDir();
  if (!dir) return null;

  for (const candidate of artifactCandidates(dir, target)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function artifactDir() {
  const configured = process.env.SPAWN_DAEMON_ARTIFACT_DIR?.trim();
  return configured ? path.resolve(configured) : DEFAULT_ARTIFACT_DIR;
}

function artifactCandidates(dir: string, target: string) {
  return [path.join(dir, `spawnd-${target}.tar.gz`), path.join(dir, `${target}.tar.gz`)];
}

async function artifactResponse(file: string, target: string, cleanup = false) {
  const info = await stat(file);
  const stream = createReadStream(file);
  if (cleanup) {
    stream.on("close", () => {
      rm(path.dirname(file), { force: true, recursive: true }).catch(() => {});
    });
  }
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="spawnd-${target}.tar.gz"`,
      "Content-Length": String(info.size),
      "Content-Type": "application/gzip",
    },
  });
}

async function availableTargets() {
  const dir = artifactDir();
  const targets = new Set<string>();

  if (dir) {
    try {
      for (const entry of await readdir(dir)) {
        const match = /^(?:spawnd-)?(.+)\.tar\.gz$/.exec(entry);
        if (match && TARGET_PATTERN.test(match[1])) targets.add(match[1]);
      }
    } catch {
      // Missing or unreadable artifact directories are reported as no artifacts.
    }
  }

  const builtTarget = currentTarget();
  if (TARGET_PATTERN.test(builtTarget) && (await exists(RELEASE_BIN))) targets.add(builtTarget);
  return [...targets].sort();
}

async function ensureReleaseCli() {
  if (!(await exists(BUILT_CLI)) && !(await exists(RELEASE_CLI))) {
    return "daemon CLI is not built; run `cd daemon && rebar3 escriptize`";
  }

  if (!(await exists(BUILT_CLI))) return null;
  if (await releaseCliIsCurrent()) return null;

  await copyFile(BUILT_CLI, RELEASE_CLI);
  return null;
}

async function releaseCliIsCurrent() {
  try {
    const [built, packaged] = await Promise.all([stat(BUILT_CLI), stat(RELEASE_CLI)]);
    return packaged.mtimeMs >= built.mtimeMs;
  } catch {
    return false;
  }
}

async function exists(file: string) {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function currentTarget() {
  const os =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : undefined;
  const arch =
    process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "arm64" : process.arch;

  return os ? `${os}-${arch}` : "unsupported";
}
