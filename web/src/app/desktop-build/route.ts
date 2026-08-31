import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { type DesktopPlatform, desktopArtifactFromFilename } from "@/lib/platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The desktop artifact this checkout can hand over right now, for development.
 *
 * `/api/release` answers a different question: what release identity this
 * checkout can *prove*. It refuses to name a desktop version while `desktop/`
 * has uncommitted work in it — which is most of the time you are working on
 * the desktop app — and the download button then has nothing to point at,
 * even with a freshly built image sitting in `public/desktop/` and being
 * served. This route answers the button's question instead: is there a file
 * here, and what is it called.
 *
 * Development only, and that is not caution — it is correctness. In
 * production `/desktop/` is nginx's alias over `/var/www/spawnd/desktop`
 * (`infra/nginx-spawnd.conf.example`), which Next never sees, so a file under
 * `public/desktop/` there would be advertised at a URL that 404s. Production
 * has the manifest, which is clean-checkout by construction.
 */
export async function GET(): Promise<NextResponse> {
  if (process.env.NODE_ENV === "production") return new NextResponse(null, { status: 404 });

  const dir = path.join(process.cwd(), "public", "desktop");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return new NextResponse(null, { status: 404 });
  }

  // Newest wins: several builds can pile up here, and the one you just made
  // is the one you are trying to press the button on.
  let newest: { version: string; at: number } | null = null;
  const artifactsByVersion = new Map<string, Array<{ name: string; platform: DesktopPlatform }>>();
  for (const name of names) {
    const artifact = desktopArtifactFromFilename(name);
    if (!artifact) continue;
    const { version, platform } = artifact;
    const artifacts = artifactsByVersion.get(version) ?? [];
    artifacts.push({ name, platform });
    artifactsByVersion.set(version, artifacts);
    const at = await stat(path.join(dir, name))
      .then((info) => info.mtimeMs)
      .catch(() => 0);
    if (!newest || at > newest.at) newest = { version, at };
  }
  if (!newest) return new NextResponse(null, { status: 404 });

  // The version is not an identity here. `npm run dev --onboarding` rebuilds
  // the same version every time it runs, so hash the exact local inventory.
  // Including every artifact makes the identity platform-neutral while still
  // changing when either a DMG or setup EXE is rebuilt in place.
  const artifacts = (artifactsByVersion.get(newest.version) ?? []).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const platforms = [...new Set(artifacts.map(({ platform }) => platform))].sort();
  const digest = createHash("sha256");
  try {
    for (const artifact of artifacts) {
      digest.update(artifact.name);
      digest.update(await readFile(path.join(dir, artifact.name)));
    }
  } catch {
    return new NextResponse(null, { status: 404 });
  }
  const build = digest.digest("hex").slice(0, 16);

  return NextResponse.json(
    { version: newest.version, platforms, build },
    { headers: { "Cache-Control": "no-store" } },
  );
}
