# CONTRACT — Phase B update-system hardening (signed manifest, monotonic counter, health gate, worker pair)

Binding for daemon (D3), server (S3), and scripts/docs (T). Source: docs/MASTERPLAN.md Part 6
ADOPT-NOW #1–#4 and docs/masterplan/RESEARCH-updates.md §B. Everything is additive; an old
daemon against a new server keeps working (it ignores the new fields); a NEW daemon against an
old server (no signed manifest) refuses to update and says why (never updates unsigned).

## 1. Manifest v2 + detached signature (written by `scripts/deploy-prod.sh` via `scripts/release-lib.sh`)

`daemon/target/prebuilt/manifest.json` (on the production host) gains one field:
```json
{
  "commit": "<40hex>",
  "tree": "<40hex daemon tree>",
  "version": "0.1.0+g<commit12>",
  "release_counter": <int — the unix committer timestamp of `commit`: git show -s --format=%ct <commit>>,
  "targets": { "<target>": { "spawnd_sha256": "<64hex>", "spawn_worker_sha256": "<64hex>" } }
}
```
Beside it, `manifest.json.sig`: the unpadded base64url Ed25519 signature over the EXACT BYTES of
`manifest.json` as written (no canonicalisation step — the server serves the file byte-for-byte
and the daemon verifies the bytes it downloaded before parsing). Deploy writes `manifest.json`
then `manifest.json.sig`, each atomically (tmp + mv), signature last.

Signing key: Ed25519. Private key = 32-byte seed, unpadded base64url, one line, in the file
`${SPAWN_RELEASE_SIGNING_KEY:-$HOME/.config/spawn/release-signing.key}` (mode 0600) on the
operator's Mac — NEVER in the repo, NEVER on the server, NEVER in CI. The public key is a
constant in the daemon (`daemon/src/release_key.rs`: `RELEASE_SIGNING_PUBLIC_KEY` unpadded
base64url 32 bytes; `key_id` = first 8 hex chars of sha256(raw pubkey)) and is ALSO written into
the manifest as `"signing_key_id": "<8hex>"` so a mismatch is diagnosable.

`scripts/release-lib.sh` gains: `release_counter_for_commit <sha>`, `sign_prebuilt_manifest <manifest-path> <sig-path>` (uses `uv run --project server python` with `cryptography`), `verify_prebuilt_manifest_signature <manifest> <sig> <pubkey-b64url>`, and `release_signing_public_key` (derives the pubkey from the private key file). `deploy-prod.sh` refuses to publish prebuilts when the key file is missing/unreadable (the same hard gate class as a missing release; `SPAWN_DEPLOY_PREBUILTS=0` remains the loud override). `scripts/verify-release.sh` fetches `/api/install/manifest.json{,.sig}` and verifies the signature against the daemon's committed public key (extracted from `daemon/src/release_key.rs`), and checks `release_counter` == the counter of the expected commit. `docs/RELEASE.md` documents key custody, the loss plan (a new key ships in an update signed by the old key: the daemon accepts a manifest whose `signing_key_id` matches ANY key in its pinned list, so the list can carry two keys across a rotation), and the OTA kill switch (`eas update:rollback` / `eas update:revert-update-rollout`; expo-updates emergency launch).

The PRODUCTION public key (generated 2026-08-25 on the operator's Mac; private key at the path
above, never committed): `RELEASE_SIGNING_PUBLIC_KEY = "8nE_rD4eVv8QFuNMbBQ3023vuU7V-OWxRl70ni4WOf0"`,
`key_id = "e65c013f"`.

## 2. Server (S3)
- New setting `SPAWN_PREBUILT_DIR` (env; default `<repo>/daemon/target/prebuilt`) — the directory
  holding `manifest.json`, `manifest.json.sig`, and the served `spawnd-<target>` /
  `spawn-worker-<target>` binaries. `release.py`'s `MANIFEST_PATH` module override stays for unit
  tests; the env is what the e2e harness uses. `release.refresh()` semantics unchanged.
- `GET /api/install/manifest.json` → the manifest file bytes exactly, `application/json`, `Cache-Control: no-store`; 404 when there is no VALID manifest (same validity rule `/api/release` uses today: every listed binary present with the advertised hash).
- `GET /api/install/manifest.json.sig` → the signature file bytes exactly, `text/plain`, no-store; 404 when absent.
- `/api/release` `daemon` section gains `"release_counter": int|null` and `"signed": bool` (sig file present beside a valid manifest). Manifest validation TOLERATES the new fields (`release_counter` int ≥ 0 when present; `signing_key_id` string when present) — never rejects a manifest for carrying them, never requires them.
- `daemon.update` frame gains optional `"allow_downgrade": true` — set only when `POST /api/hosts/{id}/update` was called with body `{"allow_downgrade": true}` (operator intent; default false; auto-updates never set it).
- `daemon.update_result.stage` accepts the new value `"health"` (alongside `download|verify|swap|exec|precondition`). A `health` failure marks that tree `failed` for the host exactly like other failures (never auto re-pushed; manual `POST …/update` retries as today).
- Register gains the optional key `"worker_mismatch": true` (absent/false when the pair matches). It is NOT a `self_update_blocked` class: `self_update` stays `true` and `self_update_blocked` stays `null` so the update can flow. Server behaviour: `HostOut.update.error = "worker_mismatch"` while the flag is set (state stays whatever the tree comparison says); AND the server pushes a **repair** `daemon.update` for the manifest tree after `registered` whenever `worker_mismatch` is true and a valid manifest exists — even when `host.daemon_tree == manifest.tree` (the pair is broken; re-applying the release fixes it). The daemon accepts a same-tree update while in `worker_mismatch` (the usual same-tree no-op idempotence is bypassed only in that state). `POST /api/hosts/{id}/update` likewise allows a same-tree request for a `worker_mismatch` host (200/202 instead of the `current` no-op).

## 3. Daemon (D3)
- Build stamps (`build.rs`): `SPAWND_BUILD_COUNTER` = `git show -s --format=%ct HEAD` (empty outside git). Test-only overrides honoured at build time with `cargo:rerun-if-env-changed`: `SPAWND_DAEMON_TREE_OVERRIDE`, `SPAWND_BUILD_COUNTER_OVERRIDE`, `SPAWND_RELEASE_PUBLIC_KEYS_OVERRIDE` (comma-separated base64url pubkeys replacing the pinned list). Production builds never set them.
- Before trusting ANY sha256 (pushed `daemon.update` or `spawnd update`): fetch `/api/install/manifest.json` and `/api/install/manifest.json.sig` from the daemon's own origin (path-pinned exactly like binaries), verify the signature against the pinned key list; check the frame's `tree` and both sha256s equal the manifest's for this target; check `manifest.release_counter >= SPAWND_BUILD_COUNTER` unless the frame carries `allow_downgrade: true`. Failures: stage `verify` with error classes `manifest_missing` (404), `manifest_unsigned` (sig 404), `manifest_bad_signature`, `manifest_mismatch` (tree/sha differ), and stage `precondition` with error `downgrade`. Local-dev escape hatch: `SPAWND_ALLOW_UNSIGNED_UPDATE=1` skips signature+counter checks and logs once at warn (documented in daemon/CLAUDE.md; never set by any script that touches production).
- Health gate (already built by D2 — verify, keep): `spawnd.updating` probation marker; Registered within 5 min deletes marker + `.prev`; attempts ≥ 2 or deadline → revert both binaries from `.prev`, exec, then `daemon.update_result {ok:false, stage:"health", tree:<reverted-from tree>}` after the reverted daemon registers.
- Worker pair cross-check (D2 built it as a `self_update_blocked: "worker_mismatch"` class — CHANGE IT to the §2 shape): mismatch → register carries `"worker_mismatch": true` with `self_update: true` / `self_update_blocked: null`; refuse NEW sessions with a clear error; running workers untouched; a pushed or `spawnd update` same-tree update is ACCEPTED while in this state (repair), after which the pair matches and the flag clears on the next register.
- `spawnd doctor` check 10 (worker binary) and check 12 (version) read the same code paths.

## 4. Test harness (T) — how the harness builds two identities
Two builds of HEAD: `SPAWND_DAEMON_TREE_OVERRIDE=<40hex-A> SPAWND_BUILD_COUNTER_OVERRIDE=1000 SPAWND_RELEASE_PUBLIC_KEYS_OVERRIDE=<test-pub> cargo build …` → "v-old"; same with tree B / counter 2000 → "v-new". The harness generates a throwaway Ed25519 keypair, writes a manifest for v-new (tree B, counter 2000) + `.sig`, and points a local server's `MANIFEST_PATH` (release.py already supports `MANIFEST_PATH` for tests) at it. Downgrade cell: manifest counter 500 → the daemon refuses with `precondition/downgrade`; with `allow_downgrade` via `POST /api/hosts/{id}/update {"allow_downgrade": true}` it proceeds.
