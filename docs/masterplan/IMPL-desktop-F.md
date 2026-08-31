# IMPL — desktop F

## Outcome

Stage 1 of the macOS SPAWN D desktop companion is implemented as a standalone
Tauri v2 app. It is tray-first, uses only bundled local HTML/TypeScript/CSS,
keeps app and daemon credentials separate, downloads and verifies daemon
binaries from the chosen control plane, and pins app updates to the independently
signed vendor channel.

No git write, deploy, workflow dispatch, Developer ID signing, notarization or
publication command was run.

## Files

- Root/release surfaces: `CLAUDE.md`, `.github/workflows/desktop.yml`,
  `docs/RELEASE.md`, `scripts/verify-release.sh`.
- Website exception (web-only by nature): `web/src/app/download/page.tsx`,
  `web/src/lib/platform.ts`.
- Desktop ownership: `desktop/.gitignore`, `desktop/CLAUDE.md`,
  `desktop/AGENTS.md` (symlink to `CLAUDE.md`), `desktop/package.json`,
  `desktop/package-lock.json`, `desktop/index.html`, `desktop/tsconfig.json`,
  `desktop/vite.config.ts`, `desktop/updater.pubkey`.
- Bundled UI: `desktop/src/main.ts`, `desktop/src/styles.css`.
- Tauri crate/config: `desktop/src-tauri/Cargo.toml`,
  `desktop/src-tauri/Cargo.lock`, `desktop/src-tauri/build.rs`,
  `desktop/src-tauri/tauri.conf.json`,
  `desktop/src-tauri/tauri.beta.conf.json`,
  `desktop/src-tauri/tauri.ci.conf.json`,
  `desktop/src-tauri/capabilities/default.json`,
  `desktop/src-tauri/icons/icon.png`, `desktop/src-tauri/icons/icon.icns`.
- Rust implementation: `desktop/src-tauri/src/api.rs`, `auth.rs`,
  `crypto.rs`, `install.rs`, `lib.rs`, `main.rs`, `models.rs`,
  `storage.rs`, `supervision.rs`, `tray.rs`, `trust.rs`,
  `updater_config.rs`.

No `server/`, `mobile/`, or `daemon/` file was changed by this stream.

## Checklist

1. **Workspace/shell/identity — complete.** Standalone `desktop/src-tauri`
   crate links `../../daemon`; root map and desktop working agreement are
   present; `AGENTS.md` is a symlink. macOS uses
   `ActivationPolicy::Accessory`, hides close-requested windows, and exposes
   the specified tray order. The token and device seed use Keychain service
   `spawn`. Device registration is the V2 account-bound proof, with an
   ordinary revocable device row. Test:
   `fingerprints_use_the_daemon_wire_format`.

2. **Sign-in/SAS — complete.** Password login/signup, provider browser start,
   deep-link callback, and one-time-code exchange are implemented. The exact
   redirect sent is `spawn://oauth/callback`; exchange sends only
   `{"code":"…"}`. Existing accounts enter the mobile-compatible pairing
   joiner flow, verify commitment and incoming endorsement, show the 4-digit
   projection, and reciprocally endorse before continuing. It cannot be
   skipped. Tests: `oauth_uses_the_one_registered_desktop_redirect`,
   `device_ceremony_uses_the_mobile_four_digit_projection`.

3. **Server picker — complete.** `spawnd.dev` is the default; Advanced exposes
   the self-hosted URL input and the native validation/error contract. Test:
   `server_url_validation_matches_the_native_client_contract`.

4. **Possess — complete.** The app mints an empty-body attended setup claim,
   feature-detects a prebuilt from `/api/release`, verifies the exact signed
   `/api/install/manifest.json` bytes against the daemon-pinned key, verifies
   both SHA-256s, atomically installs the pair under `~/.local/bin`, and spawns
   `spawnd possess --setup-token <claim> --no-qr`. The stable
   `spawn:   https://…?ref=…#k=…` pipe line is bound to the claim's approval
   reference. A canonical exact key match enables one **Possess this Mac**;
   a malformed fragment, reference swap, fingerprint mismatch, or key mismatch
   hard-refuses with **This host could not be verified.** and no override.
   Truly absent `#k` uses the full-fingerprint screen. Approval signs the
   daemon crate's exported `SPAWN-HOST-PAIR-APPROVE-V1` transcript. The
   device-token-accessible host-introduction endpoint exists and is published
   best-effort, with retries while the claim remains active. Tests:
   `parses_only_the_stable_plain_url_and_fingerprint_lines`,
   `approval_url_distinguishes_missing_and_malformed_key_fragments`,
   `manifest_verification_covers_the_exact_downloaded_bytes`,
   `sha256_contract_is_lowercase_and_exact`.

5. **Tray/supervision/repair — complete for Stage 1.** Status reads
   `spawnd status --json`, optional `doctor --json`, exact `state.json`,
   `launchctl print`, `GET /api/hosts`, `/api/release`, and bounded log
   tails. The tray renders host/session/daemon update summaries. Repair first
   reruns `spawnd possess`, then offers the verified reinstall, then logs.
   Settings opens the chosen origin in the system browser and confirms before
   `spawnd exorcise --yes`. Quit shows the exact daemon-survival copy.
   Test: `heartbeat_contract_rejects_oversized_or_unknown_shapes`.

6. **Updater — complete/configured, deliberately not contacted.** Stable and
   beta endpoints are vendor-pinned; Tauri updater checks and installs signed
   updates. The production public key is baked into config and committed.
   Tests: `stable_and_beta_channels_remain_vendor_pinned`,
   `updater_manifest_parser_requires_version_and_platform`,
   `tauri_configs_pin_the_committed_key_and_both_vendor_channels`.

7. **CI/release/verifier/docs — complete.** The manual-only workflow builds
   both Darwin architectures with `tauri-action`, Apple signing and
   notarization secret placeholders, produces DMGs plus app updater archives,
   and uploads without publishing. The updater key is absent from CI.
   `verify-release.sh` has `--skip-desktop`, cross-checks version/tree/
   platforms, fetches one static updater artifact, verifies its prehashed
   minisign signature and trusted-comment global signature, and retains the
   existing table. A generated valid fixture passed; appending bytes caused the
   same verifier to reject it. `docs/RELEASE.md` documents piece five and key
   loss/recovery.

8. **Website — complete.** The Mac plate leads with **Get SPAWN D for Mac**,
   version and abbreviated desktop tree SHA, with Apple-silicon and Intel DMG
   links. The curl path is under **Servers and Linux**. The additive desktop
   payload parser hides the entire plate when `desktop` is absent, null, dirty
   or malformed. This is web-only by nature: it advertises a Mac artifact and
   does not create a mobile product surface.

## Verification

```text
cd desktop/src-tauri && cargo fmt && cargo build && cargo test && cargo clippy -- -D warnings
  12 passed; 0 failed
  Finished clippy dev profile; -D warnings accepted

cd desktop && cargo tauri build --debug
  Built application at: .../desktop/src-tauri/target/debug/spawn-desktop
  Bundling SPAWN D.app (.../target/debug/bundle/macos/SPAWN D.app)
  Finished 1 bundle

scripts/check-claude-md.sh
  check-claude-md: every tracked directory is documented

bash -n scripts/*.sh && scripts/verify-release.sh --help
  exit 0; help includes --skip-desktop

cd web && npm run lint && npx tsc --noEmit && ... bun test src
  Biome: no errors (four unrelated concurrent warnings and one size info)
  TypeScript: exit 0
  1106 pass; 0 fail

cd server && .venv/bin/ruff check . && .venv/bin/python -m pytest -q tests/test_release.py
  All checks passed
  6 passed in 0.21s

desktop updater verifier fixture
  valid fixture: OK
  tampered fixture: rejected

git diff --check
  exit 0; no output
```

The unsigned/local (ad-hoc only for the attempted sandbox smoke; no Developer
ID identity) app is:

`/Users/charliesaxton/dev/spawn/desktop/src-tauri/target/debug/bundle/macos/SPAWN D.app`

## Manual local smoke

- Created isolated SQLite state at
  `/private/tmp/spawn-desktop-smoke.p2AG75`, migrated it through Alembic 0064,
  and started the current server with in-process pubsub at
  `http://127.0.0.1:8166`.
- Proved `/healthz` 200, password login 200 and setup-claim mint 201 against
  that scratch server. `/api/release` honestly returned `daemon: null`, and
  both signed-manifest URLs returned 404. Therefore a Possess attempt would
  stop at “doesn't serve a build for this Mac” before writing either existing
  `~/.local/bin` binary.
- Launched the debug executable with
  `SPAWN_CONFIG_DIR=/private/tmp/spawn-desktop-smoke.p2AG75/daemon-config`.
  The Codex execution sandbox aborted AppKit during `_RegisterApplication`
  before a wizard window was available; LaunchServices launch returned
  `NSOSStatusErrorDomain -10827`, and the required OS screen-capture preflight
  was also blocked by the sandbox. The crash diagnostic is
  `~/Library/Logs/DiagnosticReports/spawn-desktop-2026-08-26-014304.ips`.
  Consequently the UI sign-in, server picker, and Possess button could not be
  manually driven in this environment. The local server/API half reached the
  setup-claim boundary; no daemon binary or service was mutated. The uvicorn
  process shut down cleanly afterward.

## Updater key custody

The generated scratch private key is outside the repository at:

`/private/tmp/spawn-desktop-updater-v2.key`

It is mode 0600. Its public half is the value committed in
`desktop/updater.pubkey` and `tauri.conf.json`. This is a local scratch
release key, not a published production credential; move it to the release
operator's protected custody plus one password-manager backup before any real
desktop release. Losing both copies strands installed apps. The superseded
scratch keypair was deleted; no private key was written to the repo, CI, logs
or server.

## Undone / expected not run

- Developer ID signing, real notarization, GitHub workflow dispatch and artifact
  publication were not run. The workflow contains placeholders only.
- No real `/desktop/latest.json` or beta manifest exists, so the updater was
  configured and parsed in tests but never exercised against a real endpoint.
- No production DMG/archive was promoted, locally updater-signed, or published.
- The full GUI smoke is blocked as recorded above; it is the only requested
  verification that did not reach its user-visible end.
- Stage 2 and Stage 3 were intentionally excluded: no sessions-at-a-glance data
  submenu, no “Possess another machine,” no tray-side approval of other devices,
  no Linux AppImage, no first-class multi-account UI, no embedded packaged web
  client, reproducible-build pipeline, or Windows app.

## Notes for S4 / W5

### S4 exact release schema

Add a display-only, optional `desktop` member to `GET /api/release`:

```json
{
  "desktop": {
    "version": "0.1.0",
    "tree": "<git rev-parse HEAD:desktop>",
    "platforms": ["darwin-aarch64", "darwin-x86_64"]
  }
}
```

`desktop.version` comes from
`desktop/src-tauri/tauri.conf.json`; `tree` is exactly
`git rev-parse HEAD:desktop`. Unknown, absent-directory or dirty checkout
identity must make `desktop: null`, exactly like the other unknown identities.
Do not add artifact signatures or authority to this block; the updater trusts
only its baked minisign key and vendor static manifest.

### OAuth allow-list

The exact native redirect sent by this app is:

`spawn://oauth/callback`

Add that exact string to the server's native OAuth redirect allow-list while
retaining the mobile entry `spawn://auth/oauth`. Matching remains exact.

### Static release paths / W5

Release promotion must serve:

- `/desktop/latest.json` and `/desktop/beta/latest.json`
- `/desktop/SPAWN-D_<version>_darwin-aarch64.dmg`
- `/desktop/SPAWN-D_<version>_darwin-x86_64.dmg`
- the corresponding signed `.app.tar.gz` updater payloads referenced by the
  manifest.

The website is already absence-tolerant: it shows no Mac plate until the exact
non-null S4 block is live. All other runtime endpoints required by Stage 1 are
present on the current branch, including setup claims and host introductions.

Stage 2 remains the sessions-at-a-glance/API surface, “Possess another machine,”
tray-side approval of other devices, Linux and the multi-account UI. Stage 3
remains the bundled web client/passkey bridge, reproducible served-client proof
and Windows.
