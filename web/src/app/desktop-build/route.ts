import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The name `scripts/publish-desktop.sh` gives every disk image it uploads. */
const DMG = /^SPAWN-D_(?<version>[^_/\\]+)_(?<platform>darwin-(?:aarch64|x86_64))\.dmg$/u;

/**
 * The disk image this checkout can hand over right now, for development.
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
  const platformsByVersion = new Map<string, Set<string>>();
  for (const name of names) {
    const match = DMG.exec(name);
    if (!match?.groups) continue;
    const { version, platform } = match.groups;
    const set = platformsByVersion.get(version) ?? new Set<string>();
    set.add(platform);
    platformsByVersion.set(version, set);
    const at = await stat(path.join(dir, name))
      .then((info) => info.mtimeMs)
      .catch(() => 0);
    if (!newest || at > newest.at) newest = { version, at };
  }
  if (!newest) return new NextResponse(null, { status: 404 });

  return NextResponse.json(
    { version: newest.version, platforms: [...(platformsByVersion.get(newest.version) ?? [])] },
    { headers: { "Cache-Control": "no-store" } },
  );
}
