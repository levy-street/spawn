Read docs/MASTERPLAN.md in this repo end to end before doing anything else — it is the complete, binding plan (context, what's already committed on this branch, every remaining phase, the test programme, and the acceptance criteria), with full source reports in docs/masterplan/.

Your goal: execute that plan to completion — make the SPAWN D daemon experience clean, flawless, and regression-proof — developing and testing everything locally, end to end. You have full computer use: boot local servers, daemons, browsers, simulators, network-fault tools — whatever proves it works.

Hard rules (they override everything):
- All work on branch native-daemon-fixes-auto-update-daemon. Commit per-phase with pathspecs and push the branch regularly. NEVER push/merge to master; never open a PR.
- NEVER deploy or publish anything: no deploy-prod.sh runs against prod, no eas build/update, no OTA, nothing touching spawnd-prod beyond read-only ssh probes.
- Real verification at every step: the repo's per-folder checks plus the MASTERPLAN Part 8 test programme (updater e2e, fault injection, version-skew matrix, connection chaos drills, A/B canary cohorts). A phase is not done until its tests exist and pass.
- Follow every CLAUDE.md working agreement; both frontends ship together; user-facing copy says "SPAWN D"; heed the two documented traps in MASTERPLAN's intro.

Work autonomously through the phases in MASTERPLAN Part 9 order, keep the plan document's status table current as you land things, and finish with a summary of what shipped, what's tested, and anything you left open with reasons.
