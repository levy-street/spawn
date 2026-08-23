# P3-04 — Test, lint and typecheck hardening

**Phase 3, parallel with five other agents.**

## 1. Objective

Get the whole `mobile/` tree green and keep it that way, and make the campaign's verification
reproducible.

## 2. Files you own

```
mobile/tests/**              # shared setup, helpers, factories (NOT other agents' suites)
mobile/jest.config.js or the jest block in package.json
mobile/biome.json
mobile/tsconfig.json
scripts/mobile-ci.sh
```

You may fix a **broken or flaky test** in any agent's suite, and you may fix a **type error or lint
error** anywhere — those are the exception to path ownership, because a red tree blocks everyone.
You may not change product behaviour to make a test pass. If a test fails because the code is
wrong, fix the test's expectations only when the test is wrong; otherwise record it as a finding
and, if it is a genuine defect, fix the code minimally and say exactly what you changed and why.

## 3. Specification

- Get `npm run typecheck`, `npm run lint`, `npm test` green across the tree.
- Build shared test infrastructure other suites can adopt: fixture factories for workspace/tab/
  session/host/agent shapes, a fake API layer, a fake transport, a fake socket, a themed render
  helper. Put them in `tests/` and document them in your report.
- Remove duplication where several agents wrote the same mock, but do not rewrite their tests.
- Coverage: report it, set a floor only if it is comfortably met; do not chase a number.
- Flake: run the suite repeatedly; anything order-dependent or timer-dependent gets fixed or
  quarantined with a note.
- `scripts/mobile-ci.sh`: typecheck → lint → test → `expo export --platform ios`, failing fast,
  runnable from a clean checkout. This is the campaign's reproducible gate.
- Confirm no test requires a device, a network, a server or a real terminal. Any that does is a
  defect — report and fix.

## 4. Deliverables checklist
- [ ] Whole tree green: typecheck, lint, test
- [ ] Shared fixtures/fakes documented for reuse
- [ ] Flake eliminated or quarantined with notes
- [ ] `scripts/mobile-ci.sh` working end to end
- [ ] No test touches a device or network
- [ ] Progress current; report written

## 5. Reporting
Progress `docs/native/progress/P3-04.md`; report `docs/native/reports/P3-04.md` with the final
command output, coverage summary, and every change you made inside another agent's files.
