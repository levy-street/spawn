# IMPL — scripts T1: release signing groundwork and release docs

Implemented 2026-08-25 on `native-daemon-fixes-auto-update-daemon`. This
workstream touched only the allowed scripts/docs paths and the two allowed
server test files. No deployment, EAS command, production write, or writing
git command against the shared checkout was run (the supplementary deploy
tests create and commit only inside their isolated temporary repositories).

## Files

- `scripts/release-lib.sh`
- `scripts/deploy-prod.sh`
- `scripts/verify-release.sh`
- `scripts/verify-prebuilts.sh`
- `server/tests/test_deploy_prod_script.py`
- `server/tests/test_verify_release_script.py` (new)
- `docs/RELEASE.md`
- `docs/NETWORK.md`

## Per-item checklist

### 1. `release-lib.sh` signing contract — complete

- Added `release_counter_for_commit <sha>` using
  `git show -s --format=%ct <sha>`.
- Added the requested public-key derivation, exact-byte Ed25519 sign, and
  signature verification helpers. They validate canonical, unpadded base64url
  encodings and use `uv run --project server --frozen python` with
  `cryptography`; the seed never becomes a command argument or output.
- Added key-path/readability, key-id, and Rust public-key-list helpers used by
  deploy and verification.
- Manifest rendering now requires/emits integer `release_counter` and 8-hex
  `signing_key_id`.
- `release_contract_self_test` generates two throwaway seeds, signs/verifies a
  manifest, rejects a byte-flipped manifest, rejects a wrong key, and covers
  missing-key readability plus the existing tree/override gate.
- Tests: deploy `--self-test` via
  `test_deploy_self_test_covers_release_contract_without_remote_calls`;
  `test_manifest_renderer_includes_signed_release_identity`;
  `test_release_key_parser_accepts_daemon_rotation_list`.

### 2. `deploy-prod.sh` publication gate and public proof — complete

- A verified prebuilt snapshot is publishable only with a present, readable,
  valid signing seed. A missing key becomes the same `prebuilt_ready=0` gate
  class as a missing release, so a daemon-tree change is refused before the
  remote deploy. An unchanged daemon tree may continue without publishing,
  matching the pre-existing missing-release behavior.
- `SPAWN_DEPLOY_PREBUILTS=0` remains the explicit override and now prints the
  additional exact warning that daemons refuse unsigned manifests.
- Deploy renders and signs locally. It uploads both temp files, atomically
  renames `manifest.json`, then atomically renames `manifest.json.sig` last.
- After publication it fetches both paths through
  `SPAWN_DEPLOY_PUBLIC_ORIGIN`, requires the served manifest bytes to equal the
  locally signed bytes, and verifies the detached signature against the public
  key derived from the local seed. Exhausted retries print the rollback command
  and require restoration/republication of the last known-good signed pair.
- Tests: `test_deploy_signing_key_gate_and_unsigned_override_warning_are_pinned`;
  `test_deploy_self_test_covers_release_contract_without_remote_calls`; the
  existing `tests/test_deploy_script.py` suite remains green (16 tests).

### 3. release verifiers — complete

- `verify-release.sh` fetches the public manifest and signature and verifies
  against keys parsed from `daemon/src/release_key.rs` at the requested git
  ref. If that committed file is absent, it accepts
  `SPAWN_RELEASE_PUBLIC_KEY` and identifies the fallback in the PIECE table.
- Added required `daemon manifest signature` and `daemon release counter`
  rows, plus a signed-manifest-tree row. Signature success also requires the
  manifest key id to match the verifying raw public key.
- Served binary hashes are now anchored to the signed manifest; verifier also
  fails when `/api/release` advertises different hashes.
- `verify-prebuilts.sh` prints and enforces the manifest signature status before
  its GitHub-release binary comparison.
- Tests: `test_verify_release_accepts_throwaway_signed_manifest` uses a local
  threaded stdlib HTTP server and a throwaway Ed25519 key;
  `test_verify_release_rejects_wrong_release_counter` pins monotonic-counter
  failure and table output.

### 4. script contract tests — complete

- Expanded `server/tests/test_deploy_prod_script.py` for self-test, fields,
  signing gate/override warning, atomic signature-last publication text, and
  rotation-list parsing.
- Added `server/tests/test_verify_release_script.py` with no network or real
  git dependency. Its fake `git` handles a pinned `master`-style identity and
  deliberately makes `release_key.rs` absent to exercise the documented env
  fallback.

### 5. `docs/RELEASE.md` — complete

- Added signed-byte and signature-format contract, local key location/custody,
  0600 mode, password-manager backup, production public key/id, rotation overlap
  procedure, and the honest reinstall-wave loss plan.
- Documented what `verify-release.sh` proves, automatic no-downgrade behavior,
  and the exact `POST /api/hosts/{id}/update {"allow_downgrade": true}` operator
  escape hatch.
- Added the OTA kill switches `eas update:rollback` and
  `eas update:revert-update-rollout`, plus expo-updates emergency launch.
- Added the previous/new server/daemon skew ritual and defined A/B as
  interleaved canary cohorts.

### 6. `docs/NETWORK.md` horizon — complete

- Added a watch-only, not-planned WebTransport signalling / MASQUE relay
  paragraph with the A5 research links and an explicit end-to-end maturity
  threshold.

## Verification tails

```text
$ PATH=/opt/homebrew/bin:$PATH bash -n scripts/*.sh
<no output; PASS>

$ scripts/release-lib.sh --self-test
release-lib: self-test ok

$ scripts/deploy-prod.sh --self-test
connection-probe: self-test ok
health: self-test ok
deploy-prod: self-test ok

$ cd server && .venv/bin/python -m pytest -q \
    tests/test_deploy_prod_script.py tests/test_verify_release_script.py
.........                                                                [100%]
9 passed in 3.12s

$ cd server && .venv/bin/python -m pytest -q tests/test_deploy_script.py
................                                                         [100%]
16 passed in 28.29s

$ cd server && .venv/bin/ruff check \
    tests/test_deploy_prod_script.py tests/test_verify_release_script.py
All checks passed!

$ scripts/check-claude-md.sh
check-claude-md: every tracked directory is documented

$ git diff --check -- scripts docs server/tests/test_deploy_prod_script.py \
    server/tests/test_verify_release_script.py
<no output; PASS>
```

The production seed was read only through `release_signing_public_key`; without
printing key material, a bounded check confirmed its derived public key is
`8nE_rD4eVv8QFuNMbBQ3023vuU7V-OWxRl70ni4WOf0`, its derived id is `e65c013f`,
and its file mode is `0600`.

## Undone / why

- No live-origin `verify-release.sh` or `verify-prebuilts.sh` run: the signed
  server endpoints and daemon pinned-key file are concurrent S3/D3 work, and
  this stream was explicitly forbidden from touching production. The local
  HTTP test covers the same signature/counter path without that dependency.
- `daemon/src/release_key.rs` was not present when this report was written.
  The verifier's required temporary fallback is implemented and visibly named
  in its PIECE row; once D3's file is committed at the verified ref, the file
  takes precedence and an unparsable/empty file is a hard verification failure.
- Phase B test-programme items in RESEARCH-updates section C were intentionally
  not built in T1; this brief required signing groundwork only.

## Notes for D3 / S3 / T2

- Exact host files: `daemon/target/prebuilt/manifest.json` and
  `daemon/target/prebuilt/manifest.json.sig`. Exact public endpoints:
  `/api/install/manifest.json` and `/api/install/manifest.json.sig`.
- Signature: Ed25519 over the exact bytes of `manifest.json`, with no JSON
  canonicalisation. The raw 64-byte signature is encoded as one line of
  canonical unpadded base64url (a final LF is written to the `.sig` text file).
  The private material is a raw 32-byte Ed25519 seed encoded the same way.
- Counter: deploy computes `release_counter` with
  `git show -s --format=%ct <manifest.commit>`; `verify-release.sh` computes the
  expected value with the same helper for its expected commit. D3's build
  counter must use the same committer-timestamp source.
- Key id: first 8 lowercase hex characters of `sha256(raw 32-byte public key)`.
- `release_key.rs` parsing expectation: `verify-release.sh` reads
  `daemon/src/release_key.rs` from the requested git ref via `git show` and
  extracts quoted, 43-character unpadded-base64url string literals that decode
  to exactly 32 bytes. A singular constant or a rotation list both work; D3
  should keep every pinned public key as such a quoted literal. The expected
  production literal is
  `8nE_rD4eVv8QFuNMbBQ3023vuU7V-OWxRl70ni4WOf0` (`e65c013f`).
- S3 must serve both files byte-for-byte. In particular it must not parse and
  reserialize `manifest.json`, and `.sig` should retain its one-line text bytes.
- T2 throwaway manifests should use these same two file names/encodings and
  should set each manifest's `release_counter` to the identity counter compiled
  into the corresponding test daemon build.
