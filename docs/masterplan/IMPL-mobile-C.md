# M3 / Phase C mobile implementation report

## Files changed

- Alerts/push: mobile/src/components/alerts/{alert-presenter.tsx,__tests__/alert-presenter.test.tsx,__tests__/notifications.test.ts}; mobile/src/lib/notifications.ts.
- Hosts: mobile/src/components/hosts/{host-detail-view.tsx,host-list-screen.tsx,__tests__/host-views.test.tsx}; mobile/src/lib/__tests__/pairing-route-wiring.test.tsx.
- Onboarding: mobile/src/components/onboarding/{host-pairing-step.tsx,install-instructions.tsx,pairing-code-entry.tsx,pairing-countdown.tsx,pairing-screen.tsx,fingerprint-review.tsx,trust-failure-state.tsx,pairing-success.tsx,onboarding-flow.tsx}; new setup-checklist.tsx.
- Onboarding tests: mobile/src/components/onboarding/__tests__/{onboarding-components.test.tsx,pairing-query.test.ts,pairing-screen.test.tsx}; new host-pairing-claim.test.tsx, setup-checklist.test.tsx, and possess-copy.test.ts.
- Other copy: mobile/src/components/longtail/about-screen.tsx; mobile/src/components/trust/{device-approval-ceremony.tsx,device-approval-screen.tsx}.
- API/query layer: new mobile/src/data/api/{endpoints/setup.ts,schemas/setup.ts} and mobile/src/data/queries/setup.ts; modified mobile/src/data/api/{schemas/devices.ts,schemas/hosts.ts,__tests__/schemas.test.ts}, mobile/src/data/queries/pairing.ts, and mobile/src/data/queryKeys.ts.
- Deep links: mobile/src/lib/linking.ts and mobile/src/lib/__tests__/linking.test.ts.

## Per-item checklist

1. **Done — spawnd possess copy fix.** Updated every requested post-install instruction surface, preserving diagnostic spawnd login only for the host doctor's auth_rejected case. The recurring sentence is exactly “After installation, run spawnd possess on that machine.” Also corrected an adjacent user-facing “Set up Spawn” label to “Set up SPAWN D”.
   - Test: possess copy stays consistent > never teaches spawnd login as the post-install pairing step.

2. **Done — setup claim mint, command, polling, checklist.** Added schema, endpoint, query key, and hook. HostPairingStep mints a claim, displays “| sh -s -- --setup <token>”, and falls back to the base install command when claim creation is unavailable (including 404/405). GET polling runs every two seconds only while focused and app-active. The checklist is Command copied → Machine registered → Approved → Online; Online requires exact host_id match. Copy or successful share completes step 1. Contract stalled hints appear at 60 seconds.
   - Tests: setup claim checklist > maps the claim state machine and exact host id to all four steps; shows elapsed time and the $status stalled hint (pending/ready/approved, fake timers); HostPairingStep setup claim > falls back to today's bare command when claims return 404; embeds a setup claim token in the displayed shell command; setup schema tests.

3. **Done — inline full-fingerprint review.** A ready claim with approval_ref calls POST /api/auth/device/pending with approval_ref and enters the existing FingerprintReview ceremony with the contract lead. Approval uses the existing signed approval/host-online flow. Typed eight-character codes remain the fallback.
   - Tests: HostPairingStep setup claim > pre-fills FingerprintReview from pending approval_ref; pairing query > pre-fills the same fingerprint review through pending approval_ref; existing deliberate host and reciprocal phone fingerprint tests.

4. **Done — pairing push and deep link.** The parser accepts only {event:"host.pair_requested", approvalRef:"..."}. Alert presentation, cold-start responses, and foreground responses route to the same standalone review. spawn://device?ref=... and owned https://spawnd.dev/device?ref=... links work. Exact #k gives one Approve; mismatch/malformed is terminal refusal; absence keeps full comparison. The existing first-launch-after-sign-in permission/registration rule is unchanged.
   - Tests: notifications > accepts only the exact host pairing push shape; alert-presenter push routing; linking > routes host pairing refs to the pre-filled review with and without a host-key fragment; keeps a damaged identity fragment on the terminal-refusal path; pairing query > terminally refuses an approval ref whose fragment key does not match pending; onboarding security states > reduces an exact link-carried host-key match to one Approve action. Existing push > asks for permission the first time, and registers once it is granted remains green.

5. **Done — exact error catalogue.** expired, denied, key_conflict, pin_conflict, and pin_limit from claim/pending/approve normalize to distinct fail-closed states with exact shared sentences. Structured code/detail and legacy messages are recognized. Raw “user code is expired” is never presented.
   - Tests: onboarding security states > maps $wire to the exact shared failure sentence (all five); renders a distinct fail-closed $kind state; pairing query > maps protocol expiry and unknown-code responses distinctly.

6. **Done — host “Something wrong?” panel.** last_disconnect is optional for old-server compatibility. Offline selection covers never connected, auth rejected, stale/update failed, and plain offline. The single command is copyable with existing clipboard/haptics. Online omits the panel and retains status/version/update diagnostics.
   - Tests: host views > selects every offline mini-doctor case and collapses it online; accepts older host responses without last_disconnect; renders the helper only for an offline host, including copy.

7. **Done — permanent Add a machine and multi-account hint.** Hosts header and empty state route to the existing standalone PairingScreen. It receives deep-link params and uses the same checklist. The exact one-line multi-account hint appears under displayed install commands.
   - Tests: standalone host pairing route > is backed by an existing standalone pairing screen; is reachable from both connect controls on Hosts; PairingScreen direct/pushed exits; instruction render assertions.

8. **Done — waiting states never strand.** Checklist and quiet code waits show “Elapsed 0:30”. At 60 seconds they show the contract hint and an explicit Enter pairing code, Back to install instructions, or Finish later escape.
   - Tests: fake-timer stalled-hint matrix in setup-checklist.test.tsx; onboarding security states > adds an elapsed hint and an explicit escape to a quiet code wait.

**Tests: done.** Added/extended coverage for every requested area. Full mobile CI is green.

## Verification

cd mobile && npm run ci exited 0. Exact tail:

    Checked 688 files in 226ms. No fixes applied.
    Test Suites: 230 passed, 230 total
    Tests:       1593 passed, 1593 total
    Snapshots:   2 passed, 2 total
    Time:        20.336 s
    Ran all test suites.

The run emitted existing console warnings from untouched Expo Go notification, React act, and TerminalOverlay tests, but no suite failed or flaked, so no isolated rerun was needed.

git diff --check -- mobile exited 0:

    (no output)

## Undone / cut

None in mobile. The claim endpoints do not exist in this checkout yet, as expected; tests mock the shared contract and the UI falls back to the pre-claim install/code flow when claim creation is unavailable.

## Notes for S3 / W3 / D3

### S3 — server

- POST /api/setup/claims with {}. Required response: token (43-character base64url), expires_in, expires_at.
- GET /api/setup/claims/{token}. Required keys: status (pending|ready|approved|failed), nullable approval_ref, host_name, os, host_key_fingerprint, host_id, error, and expires_at. Populate host_id at approved for exact online matching. error is null or expired|denied|key_conflict|pin_conflict|pin_limit.
- Polling is two seconds while focused/active and stops at approved/failed. A 404/405 creation response is treated as unsupported.
- POST /api/auth/device/pending accepts exactly one of user_code or approval_ref. Required response: host_name, approval_nonce, host_key_algorithm:"ed25519", host_public_key, host_key_fingerprint.
- POST /api/auth/device/approve likewise accepts exactly one identifier plus the existing nonce, host identity, browser identity, and signature fields. Mobile verifies repeated host/browser identity and consumes nullable host_id.
- Pending/approve errors should expose stable expired, denied, key_conflict, pin_conflict, or pin_limit codes/detail. Legacy expired_token/text is tolerated.
- /api/hosts may include optional last_disconnect:{at,reason}; at is nullable ISO datetime, reason is null or socket_closed|superseded|keepalive_timeout|auth_rejected|server_restart|stale. The doctor also consumes last_seen_at, version, and nullable update.state (current|available|updating|failed|unsupported|unknown).
- Push data is exactly {event:"host.pair_requested", approvalRef:"<approval_ref>"}. approvalRef is camel-case. No token, key, or authority is carried.

### W3 — web

- Shared link forms: spawn://device?ref=<approval_ref> and https://spawnd.dev/device?ref=<approval_ref>, optionally #k=<43-character-base64url-host-public-key>.
- Exact fragment behavior: key match gives one Approve; mismatch/malformed is terminal refusal; absent key uses full fingerprint compare.
- Exact setup labels/hints: “Command copied”, “Machine registered”, “Approved”, “Online”; “Having trouble? Re-run the install command — it's safe to repeat.”; “The machine is waiting for your approval below.”; “Approved. Waiting for the machine to come online — this usually takes a few seconds.”
- Exact inline lead: “Fastest: open the link in the machine's terminal — it verifies the identity automatically. Or compare the fingerprint below against the terminal.”
- Exact recurring install sentence: “After installation, run spawnd possess on that machine.”
- Exact multi-account hint: “Using more than one SPAWN D account? Run the install command while signed in to the account you want this machine to join.”
- Exact failure descriptions:
  - “That code expired. On the machine, run spawnd possess again.”
  - “The approval was declined in the browser. Nothing was registered.”
  - “This machine was set up before, under a different SPAWN D account, and that account still holds its identity. Nothing was changed.” followed by the three contract remedies.
  - “The browser that approved this machine doesn't match its earlier approval. Approve again from a browser you've used with this host before — or remove the host on the web and start fresh.”
  - “This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again.”
- Host panel uses contract copy for never-connected/auth-rejected/stale-version/plain-offline and title “Something wrong?”. Diagnostic spawnd login for auth rejection is intentional.

### D3 — daemon

- Generated command is the base install command plus “| sh -s -- --setup <token>”. --setup must accept the 43-character token and advance pending → ready → approved while retaining the attended full-fingerprint ceremony.
- spawnd possess is the post-install onboarding command; it performs login and prints the eight-character fallback code/link. spawnd login remains only the auth-rejected mini-doctor command.
- Terminal links use ref=<approval_ref> and may put the exact host public key only in #k=<host_public_key>. The fragment is not server authority; mobile compares it locally with pending.
- Diagnosis depends on surfaced disconnect/update fields. Commands are spawnd doctor, diagnostic spawnd login, and spawnd update.
