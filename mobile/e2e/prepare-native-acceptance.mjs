import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [destination, platform] = process.argv.slice(2);
if (!destination || !["ios", "android"].includes(platform))
  throw new Error("Usage: node e2e/prepare-native-acceptance.mjs NEW_DIRECTORY ios|android");
const target = resolve(destination);
if (existsSync(target) || target.startsWith(`${source}/`))
  throw new Error("Acceptance build needs a new directory outside mobile/.");
const apiUrl =
  process.env.SPAWN_ACCEPTANCE_API_URL ??
  `http://${platform === "android" ? "10.0.2.2" : "127.0.0.1"}:18100`;
const parsed = new URL(apiUrl);
if (
  parsed.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "10.0.2.2"].includes(parsed.hostname) ||
  parsed.username ||
  parsed.password ||
  parsed.search ||
  parsed.hash ||
  parsed.pathname !== "/"
)
  throw new Error("Native acceptance can only contact the isolated local HTTP fixture.");
const token = process.env.SPAWN_ACCEPTANCE_TOKEN;
if (!token || token.length < 32)
  throw new Error("SPAWN_ACCEPTANCE_TOKEN needs a per-run random token.");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
function requireCandidateSource() {
  const current = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
  }).trim();
  if (current !== commit) throw new Error("Candidate HEAD changed during native preparation.");
  try {
    execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: source });
  } catch {
    throw new Error("Native acceptance requires a checkout with no tracked changes from HEAD.");
  }
}
requireCandidateSource();
const fixtureUrl = new URL(process.env.SPAWN_ACCEPTANCE_FIXTURE_URL ?? "http://127.0.0.1:18100");
if (
  fixtureUrl.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(fixtureUrl.hostname) ||
  fixtureUrl.username ||
  fixtureUrl.password ||
  fixtureUrl.pathname !== "/" ||
  fixtureUrl.search ||
  fixtureUrl.hash
)
  throw new Error("Build bootstrap must come from the runner's local fixture.");
const response = await fetch(new URL("/__acceptance/config", fixtureUrl), {
  headers: { "X-Acceptance-Token": token },
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Fixture build configuration failed: ${response.status}`);
const bootstrap = await response.json();
if (bootstrap.candidateCommit !== commit || !Array.isArray(bootstrap.iceServers))
  throw new Error("Fixture candidate/ICE configuration does not match the native build.");
// Only committed candidate inputs enter the app. In particular, do not copy
// ignored .env files, native credentials, generated projects or local modules.
const tracked = new Set(
  execFileSync("git", ["ls-files", "-z"], {
    cwd: source,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean),
);
const copiedPaths = new Set(tracked);
for (const path of tracked) {
  for (let parent = dirname(path); parent !== "."; parent = dirname(parent))
    copiedPaths.add(parent);
}
mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, {
  recursive: true,
  filter: (path) => path === source || copiedPaths.has(path.slice(source.length + 1)),
});
// npm's lockfile remains authoritative. Native compilation never installs into
// the caller's checkout or replaces its existing node_modules link.
execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: target, stdio: "inherit" });
const config = JSON.parse(
  execFileSync("npx", ["expo", "config", "--type", "public", "--json"], {
    cwd: target,
    encoding: "utf8",
    env: { ...process.env, EXPO_PUBLIC_API_URL: apiUrl, EXPO_NO_TELEMETRY: "1" },
  }),
);
delete config.owner;
delete config.android.googleServicesFile;
delete config.extra.eas;
config.scheme = "spawn-acceptance";
config.ios.bundleIdentifier = "dev.spawnd.acceptance";
// Simulator keychain access still requires an application access group. Xcode
// embeds these entitlements when using its local ad-hoc signing identity.
config.ios.entitlements = {
  ...config.ios.entitlements,
  "application-identifier": "dev.spawnd.acceptance",
  "keychain-access-groups": ["dev.spawnd.acceptance"],
};
config.android.package = "dev.spawnd.acceptance";
config.ios.infoPlist.NSAppTransportSecurity = { NSAllowsArbitraryLoads: true };
config.updates = { enabled: false, checkAutomatically: "NEVER" };
config.extra.apiUrl = apiUrl;
config.extra.nativeAcceptance = { token, candidateCommit: commit, sourceClean: true, platform };
// Cleartext is permitted only in this disposable shell; production config is
// read above and never edited. The route/controller is likewise absent there.
rmSync(join(target, "app.config.ts"));
writeFileSync(
  join(target, "app.config.js"),
  `const { withAndroidManifest } = require('@expo/config-plugins');
module.exports = () => withAndroidManifest(${JSON.stringify(config)}, config => {
  config.modResults.manifest.application[0].$['android:usesCleartextTraffic'] = 'true';
  return config;
});\n`,
  { mode: 0o600 },
);
cpSync(
  join(target, "e2e/native-controller.tsx"),
  join(target, "src/terminal/NativeAcceptanceController.tsx"),
);
// The build copy changes native config and has no sibling proto/ checkout.
// Validate the actual compiled app graph; source CI checks the test graph.
writeFileSync(
  join(target, "native-acceptance-tsconfig.json"),
  JSON.stringify(
    {
      extends: "./tsconfig.json",
      include: ["src/**/*.ts", "src/**/*.tsx", "expo-env.d.ts"],
      exclude: ["node_modules", "src/**/__tests__/**", "tests", "e2e"],
    },
    null,
    2,
  ),
);
const layoutPath = join(target, "src/app/_layout.tsx");
const layout = readFileSync(layoutPath, "utf8");
const gestureImport = 'import "react-native-gesture-handler";';
if (layout.split("<SessionRenewal />").length !== 2 || !layout.startsWith(gestureImport))
  throw new Error("Authenticated app layout changed; review the native acceptance mount.");
writeFileSync(
  layoutPath,
  layout
    .replace(
      gestureImport,
      `${gestureImport}\nimport { NativeAcceptanceController } from '@/terminal/NativeAcceptanceController';`,
    )
    .replace("<SessionRenewal />", "<SessionRenewal /><NativeAcceptanceController />"),
);
const hostSurfacePath = join(target, "src/terminal/HostTransportSurface.tsx");
const hostSurface = readFileSync(hostSurfacePath, "utf8");
const receive = "bridge.receive(event.nativeEvent.data);";
if (hostSurface.split(receive).length !== 2)
  throw new Error("Host worker bridge changed; review the acceptance observation hook.");
writeFileSync(
  hostSurfacePath,
  `import { captureNativePeerStats, captureNativeOpening } from '@/terminal/NativeAcceptanceController';\n${hostSurface}`.replace(
    receive,
    `const probe = JSON.parse(event.nativeEvent.data);
      if (probe.type === 'native-acceptance-peer') {
        captureNativePeerStats(hostId, probe.snapshot); return;
      }
      if (probe.type === 'native-acceptance-opening') {
        captureNativeOpening(probe.sessionId, probe.phase); return;
      }
      ${receive}`,
  ),
);
const terminalPath = join(target, "src/terminal/TerminalSurface.tsx");
const terminal = readFileSync(terminalPath, "utf8");
if (terminal.split(receive).length !== 2)
  throw new Error("Terminal bridge changed; review the opening timing hook.");
writeFileSync(
  terminalPath,
  `import { captureNativeOpening } from '@/terminal/NativeAcceptanceController';\n${terminal}`.replace(
    receive,
    `const probe = JSON.parse(event.nativeEvent.data);
      if (probe.type === 'ready') captureNativeOpening(sessionId, 'renderer_ms');
      if (probe.type === 'native-acceptance-content') {
        captureNativeOpening(sessionId, 'first_content_ms'); return;
      }
      ${receive}`,
  ),
);
const probe = readFileSync(join(target, "e2e/native-peer-probe.js"), "utf8").replace(
  "__NATIVE_ACCEPTANCE_RTC_CONFIG__",
  JSON.stringify({
    iceServers: bootstrap.iceServers,
    forceRelay: bootstrap.forceRelay === true,
  }),
);
const htmlPath = join(target, "assets/terminal/worker.html");
const contentProbe = `<script>
(() => {
  const api = globalThis.spawnWorker;
  const post = api.post;
  let observed = false;
  api.post = (message) => {
    post(message);
    if (message.type !== 'state' || message.state !== 'ready' || observed) return;
    observed = true;
    // Check actual xterm content after it has had a frame to paint the replay.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const buffer = api.state.term?.buffer.active;
      if (!buffer) return;
      for (let row = 0; row < buffer.length; row++) {
        if (buffer.getLine(row)?.translateToString().includes('native-ready')) {
          globalThis.ReactNativeWebView?.postMessage(JSON.stringify({type:'native-acceptance-content'}));
          break;
        }
      }
    }));
  };
})();
</script>`;
const html = readFileSync(htmlPath, "utf8")
  .replace("</head>", `<script>${probe}</script></head>`)
  .replace("</body>", `${contentProbe}</body>`);
writeFileSync(htmlPath, html);
writeFileSync(
  join(target, "src/terminal/worker/worker-html.ts"),
  `// Generated acceptance-only worker asset.\nexport const TERMINAL_WORKER_HTML = ${JSON.stringify(html)};\n`,
);
requireCandidateSource();
writeFileSync(
  join(target, "acceptance-build.json"),
  JSON.stringify(
    {
      schema_kind: platform === "ios" ? "native_simulator" : "native_emulator",
      candidate_commit: commit,
      source_clean: true,
      platform,
      app_id: "dev.spawnd.acceptance",
      configuration: "Release",
      fixture_origin: apiUrl,
      controller: "e2e/native-controller.tsx",
      force_relay: bootstrap.forceRelay === true,
    },
    null,
    2,
  ),
);
console.log(`Prepared ${platform} native acceptance at ${target}`);
