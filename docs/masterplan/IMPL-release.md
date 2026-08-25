# Stream R — release process implementation report

## 1. Files changed or added

- `.github/workflows/prebuilt.yml`
- `docs/RELEASE.md`
- `scripts/deploy-prod.sh`
- `scripts/release-lib.sh` (new)
- `scripts/smoke-install-prebuilt.sh`
- `scripts/test-all.sh`
- `scripts/update-mobile-prod.sh`
- `scripts/verify-prebuilts.sh`
- `scripts/verify-release.sh` (new)
- `server/tests/test_deploy_prod_script.py` (new)
- `server/tests/test_update_mobile_script.py`

## 2. Spec checklist

- [x] `prebuilt.yml` publish job checks out the repository with fetch depth 1.
- [x] `prebuilt.yml` writes `TREE` from `git rev-parse HEAD:daemon`.
- [x] `prebuilt.yml` restores execute permission on the Linux x86_64 binary and writes `VERSION` from its `--version` output.
- [x] Deploy preflight requires release `TREE` to match the target daemon tree and retains the legacy `COMMIT` tree-diff fallback when `TREE` is absent.
- [x] Deploy downloads and verifies one immutable `prebuilt-latest` snapshot before deployment, including `SHA256SUMS`, `COMMIT`, `TREE`, `VERSION`, complete target pairs, and VERSION/COMMIT agreement.
- [x] Deploy reads the host's current `daemon/target/prebuilt/manifest.json` before production mutation and hard-gates a changed daemon tree when the release cannot be published.
- [x] `SPAWN_DEPLOY_PREBUILTS=0` remains the explicit gate override and prints a loud daemon auto-update/reinstall warning.
- [x] Deploy publishes binaries through temporary names, renders the exact manifest contract from verified release inputs and `SHA256SUMS`, includes only complete published targets, then atomically publishes `manifest.json.tmp` with `mv`.
- [x] Deploy fetches `/api/release` after publication and proves the full server commit plus daemon tree when prebuilts were published.
- [x] Deploy compares the previous production commit to the target and prints the exact mobile OTA reminder when `mobile/` changed.
- [x] The deploy manifest renderer, tree-change gate decision, and `/api/release` comparison are factored into `release-lib.sh` and exercised by `deploy-prod.sh --self-test` without SSH/SCP/GitHub calls.
- [x] `update-mobile-prod.sh` exports `EXPO_PUBLIC_SPAWN_MOBILE_TREE="$(git rev-parse HEAD:mobile)"`.
- [x] The OTA pre-publish proof requires evaluated `extra.mobileTree` as well as `extra.apiUrl`.
- [x] The OTA served-manifest proof requires `extra.expoClient.extra.mobileTree`, the API URL, and one of the just-published update IDs.
- [x] New read-only `verify-release.sh` supports `--ref` (default `origin/master`) and `--skip-mobile`, checks server commit, daemon tree, all advertised binary hashes, and the production Expo mobile tree, prints `PIECE / EXPECTED / ACTUAL / RESULT`, and fails on mismatch.
- [x] `verify-release.sh`, deploy, and `verify-prebuilts.sh` share the canonical target table from `release-lib.sh`.
- [x] `smoke-install-prebuilt.sh` asserts `daemon: null` without a manifest, writes a hash-valid local manifest beside copied release binaries, then asserts `/api/release` advertises the expected tree/target/hashes. Any pre-existing local prebuilt directory is isolated and restored safely.
- [x] `test-all.sh` runs the deploy self-test and runs `verify-release.sh` inside the optional `SPAWN_HTTP_SMOKE_URL` block.
- [x] `docs/RELEASE.md` documents release identities, client behavior when behind, the manifest, hard gate/override, OTA tree bake/proof, updated manual TREE/VERSION release creation, and makes `verify-release.sh` the final release checklist step.
- [x] Mobile script tests pin config and served mobile-tree proof success/failure paths.
- [x] New deploy script test pins the no-remote self-test entry point.

## 3. Verification run

- `bash -n scripts/*.sh` — PASS.
- `scripts/deploy-prod.sh --self-test` — PASS: `deploy-prod: self-test ok`.
- `scripts/release-lib.sh --self-test` — PASS: `release-lib: self-test ok`.
- `scripts/verify-release.sh --help` — PASS.
- `cd server && .venv/bin/python -m pytest -q tests/test_update_mobile_script.py tests/test_deploy_prod_script.py` — PASS: `12 passed in 14.32s` on the final run (`12 passed in 18.57s` on the first run).
- `cd server && .venv/bin/ruff check tests/test_update_mobile_script.py tests/test_deploy_prod_script.py` — PASS: `All checks passed!`.
- `git diff --check -- .github/workflows scripts docs/RELEASE.md server/tests/test_update_mobile_script.py server/tests/test_deploy_prod_script.py` — PASS.

There was no failing verification output.

Per the stream instructions, I did **not** run `scripts/smoke-install-prebuilt.sh` or `scripts/test-all.sh` because they build/start shared daemon and server processes.

## 4. Left undone

- No stream-R implementation item is left undone.
- I did not edit the root `CLAUDE.md`, because it is outside stream R's ownership. The new public `scripts/verify-release.sh` command is fully documented in `docs/RELEASE.md`; if the orchestrator interprets the root agreement's “add a command” rule as requiring the root scripts map to name release verification explicitly, that one-line root update must be made by the orchestrator/owning stream.

## 5. Notes for other streams

- The release stream consumes the manifest keys literally as specified: `commit`, `tree`, `version`, and per-target `spawnd_sha256` / `spawn_worker_sha256`.
- Post-deploy proof expects `/api/release` to discover a newly moved manifest without a server restart, return `server.commit` as the full deployed SHA, and return `daemon.tree` as the manifest tree.
- Mobile proof expects the served EAS multipart manifest path `extra.expoClient.extra.mobileTree`, matching the config key `extra.mobileTree`.
- `verify-release.sh` checks only daemon targets advertised by `/api/release`, but rejects target names outside the shared four-target table.
- No unresolved wire-contract questions.
