# The Windows validation gate

Every row here is evidence that has to exist before SPAWN D is released for
x86-64 Windows. Nothing in this file has been run: the port compiles and its
tests pass on a `windows-latest` runner, and that is all a runner can tell us.
These rows are the part that needs a real machine, a real user account, and a
real Defender.

Read `docs/RELEASE.md` first — it owns the release process, the signing
identity and the order of publication. This file is only the gate that opens
before any of that starts.

## Before you begin

A disposable Windows 11 x86-64 VM on NTFS, with one primary standard user, a
second standard user, and separate admin credentials. Current Windows Update,
Edge, Defender, Windows PowerShell 5.1, PowerShell 7, WSL2 and a supported
Linux distribution. Visual Studio Build Tools with the "Desktop development
with C++" workload, the Windows SDK and SignTool, stable Rust MSVC with Clippy,
Git for Windows, Node 22, Python 3.13 and uv. Process Explorer. Developer Mode
off for the junction gate, then on only for the extra symlink cases. Keep
snapshots with WebView2 both absent and installed. The VM is never the only
backup of an identity or a key.

You do not need the signing identity to start. The `windows-package` job in
`.github/workflows/windows.yml` produces an unsigned installer for exactly this
purpose — see "Getting an installer before signing exists" below.

Record for every row: the command output, the OS build, the filesystem, the
user's privilege level, the Defender and policy state, and a screenshot for
anything judged visually. A row without retained evidence is not a passed row.

The `Source` notes name where each contract came from. Files like
`I-service.md` and `R1-process-model.md` were the port's own working reports
and are **not in this tree**; the code paths named beside them — `windows_task.rs`,
`possess.rs`, `install.py`, `windows.yml` — are.

## Getting an installer before signing exists

`windows-package` builds and bundles the desktop app on `windows-latest` with
no credentials, asserts its own output is `NotSigned`, and uploads
`SPAWN-D_<version>_windows-x86_64-setup.UNSIGNED.exe` for seven days. Trigger it
by dispatching the Windows workflow, or by putting `[package]` in a commit
subject, then download the artifact from the run.

Windows will treat it exactly as it treats any unsigned installer, which is
itself worth observing once: SmartScreen's unsigned path is the experience
every user gets until Authenticode reputation accrues. What that build cannot
give you is the signed-publisher rows in "Security, Defender and firewall" and
"Release verification" — those wait for the identity. Everything else can be
closed now.

An unsigned build is compile-and-behavior evidence only. It must never be
promoted into a public release or named in Windows-facing UI;
`scripts/publish-desktop.sh` refuses a Windows setup EXE with no Authenticode
certificate table, whatever the file is called.

## Install and service

- [ ] **Native build**
  - **Do:** In daemon/: cargo check --locked --target x86_64-pc-windows-msvc --bins; cargo check --locked --target x86_64-pc-windows-msvc --all-targets; cargo clippy --locked --target x86_64-pc-windows-msvc --all-targets -- -D warnings; cargo test --locked --target x86_64-pc-windows-msvc; cargo build --release --locked --target x86_64-pc-windows-msvc --bin spawnd --bin spawn-worker; run both release .exe --version.
  - **Expect:** No Unix API reaches the target; tests and lints pass; both binaries report the same identity; golden crypto matches checked-in vectors.
  - **Source:** I-core-daemon.md, I-service.md, I-ipc.md, I-fix1.md, windows.yml

- [ ] **PowerShell install**
  - **Do:** As the standard user, run powershell.exe -NoLogo -NoProfile -Command "irm https://<origin>/install.ps1 | iex"; repeat with pwsh -NoLogo -NoProfile -Command "irm https://<origin>/install.ps1 | iex". Complete possession.
  - **Expect:** Attached TUI accepts input; no UAC; both EXEs land in %LOCALAPPDATA%\spawn\bin; hashes match; rerun changes neither hash nor timestamp; a new shell resolves where.exe spawnd.
  - **Source:** I-dist.md, I-web-frontends.md, RELEASE.md

- [ ] **Installer switches**
  - **Do:** On restored snapshots fetch once, then run & ([scriptblock]::Create((irm https://<origin>/install.ps1))) -NewAccount; repeat with -NoLogin, -NoStart, -Foreground, -NoService, -PrebuiltOnly, -Setup legacy and -Server <same-origin>.
  - **Expect:** Every switch matches its contract; foreground remains attached; no-service writes separate logs; -Repo/-Branch fail as Unix-only; ARM64 fails before download.
  - **Source:** I-dist.md, install.py, R4-distribution.md

- [ ] **cmd + failure exit**
  - **Do:** From cmd.exe: powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Invoke-RestMethod 'https://<origin>/install.ps1' | Invoke-Expression". Run a deliberately failing fixture and inspect %ERRORLEVEL%.
  - **Expect:** Process-scoped bypass runs the fixed HTTPS script; success is zero; the first failed native command is named and returns nonzero. Machine/User policy, WDAC/AppLocker and Constrained Language remain enforced.
  - **Source:** I-dist.md, RELEASE.md, install.py

- [ ] **Scheduled Task contract**
  - **Do:** Run spawnd status --json; copy service.name; run schtasks.exe /Query /TN "<service.name>" /XML.
  - **Expect:** Name is SPAWN D spawnd-<8hex>; XML has the current SID twice, InteractiveToken, LeastPrivilege, PT1M, 255, IgnoreNew, PT0S, hidden/battery/network settings, absolute executable/working directory and exact args. JSON reports manager, exact name and daemon-owned logs.
  - **Source:** I-service.md, I-glue.md, windows_task.rs

- [ ] **Task breakaway**
  - **Do:** Keep a terminal session live. Run schtasks.exe /End /TN "<service.name>", then schtasks.exe /Run /TN "<service.name>"; inspect spawnd doctor and spawnd status --json.
  - **Expect:** task_breakaway_denied=false only when the child is outside Scheduler’s job; worker/session PID, output and scrollback survive and reconnect adopts them. Denied or inconclusive blocks Task mode.
  - **Source:** I-service.md, I-glue.md, R1-process-model.md

- [ ] **Run fallback**
  - **Do:** Force denied/in-job behavior; run spawnd possess and choose Use the Run watchdog. Also test spawnd possess --service-mode run and spawnd possess --service-mode task. Query reg.exe query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "SPAWN D spawnd-<8hex>".
  - **Expect:** Doctor/status report denial; prompt choices behave safely; data is exactly "<LOCALAPPDATA>\spawn\bin\spawnd.exe" __watchdog --instance <8hex>; the mode persists.
  - **Source:** I-service.md, I-glue.md, possess.rs

- [ ] **Watchdog lifecycle**
  - **Do:** In Run mode, Task Manager → Details → spawnd.exe → End task twice; remove/re-add the Run value; start a second watchdog; create/remove spawnd.updating.
  - **Expect:** Command stays below 260 UTF-16 units and matches protected launch.json; only one out-of-job watchdog runs; crashes back off; deletion/control stops it; no mixed pair starts behind the marker; watchdog-update-ready releases it.
  - **Source:** I-service.md, windows_run.rs

- [ ] **Account isolation**
  - **Do:** Create two accounts with spawnd possess --new-account; run spawnd reconnect, spawnd disconnect and spawnd exorcise against each separately.
  - **Expect:** Distinct task/Run names, pipes, state/log directories and origins. One account cannot affect the other; disconnect preserves workers/state/logs; exorcise/reset purges only the selected instance.
  - **Source:** I-service.md, I-glue.md

- [ ] **Logs + no console**
  - **Do:** Inflate %LOCALAPPDATA%\spawn\logs\<8hex>\spawnd.log beyond 10 MiB; exercise logon, task /Run, watchdog launch and crash restart while watching the desktop.
  - **Expect:** Log rotates to .1; tracing/panic/stderr continue; readers remain allowed; no path flashes a console. Any direct Task flash triggers the GUI-launcher blocker.
  - **Source:** I-service.md, I-glue.md

- [ ] **PATH + shell selection**
  - **Do:** Test HKCU Path as REG_SZ and REG_EXPAND_SZ with variables, duplicates and case/trailing-slash variants. Test where.exe claude, .EXE vs .CMD/.BAT, PowerShell 7, Windows PowerShell and COMSPEC-only snapshots; run spawnd doctor with Claude and Git Bash present/absent.
  - **Expect:** Registry type/raw variables survive; one normalized SPAWN D bin entry; WM_SETTINGCHANGE does not hang; expanded user + inherited system PATH merge; EXE wins; trusted shims execute safely. Doctor reports the correct pass/warn/fail state.
  - **Source:** I-core-daemon.md, I-service.md, I-glue.md

- [ ] **Console + browser**
  - **Do:** In Windows Terminal under pwsh, powershell.exe and cmd.exe, run picker/live UI; test arrows, Enter, Ctrl-C, resize, redirected streams, NO_COLOR=1 and forced VT failure. Login with ?a=1&b=two#fragment.
  - **Expect:** Modes restore on every exit; visible width is used; fallback has no raw escapes; one browser navigation gets the exact URL; non-interactive launch fails promptly to the printed URL; no console flash.
  - **Source:** I-core-daemon.md, I-glue.md


## Sessions and IPC

- [ ] **Pipe + worker tests**
  - **Do:** In daemon/: cargo test --locked --target x86_64-pc-windows-msvc sessiond::endpoint:: -- --nocapture and cargo test --locked --target x86_64-pc-windows-msvc --test worker_e2e -- --nocapture.
  - **Expect:** Flat short pipe names, owner DACL/peer SID checks, first-instance rolling behavior, reservation exclusivity, silent-client bound, split metadata/log paths and real cmd/ConPTY fixture pass.
  - **Source:** I-ipc.md, I-fix1.md, endpoint/windows.rs

- [ ] **Pipe isolation**
  - **Do:** As owner, second standard account and another host, try both \\.\pipe\.../\\<host>\pipe\... and the .lock/.endpoint files while the owner pings/reconnects.
  - **Expect:** Owner succeeds; second user and remote are denied; neither can displace the worker; a squatted first pipe fails startup closed.
  - **Source:** I-service.md, I-ipc.md

- [ ] **Control pipe**
  - **Do:** Run cargo test --locked --target x86_64-pc-windows-msvc service::control:: -- --nocapture; then owner spawnd status, spawnd reconnect, spawnd disconnect while a second account/host attempts the same.
  - **Expect:** One local owner client; remote/second user/second server denied; invalid frames rejected; each valid ping/reconnect/shutdown acknowledged exactly once before action.
  - **Source:** I-service.md, service/control.rs

- [ ] **Process identity**
  - **Do:** Run cargo test --locked --target x86_64-pc-windows-msvc state:: -- --nocapture; record live daemon PID, image and process_started_100ns; run spawnd status --json.
  - **Expect:** Limited query + synchronize, zero-time wait, STILL_ACTIVE, full image and creation time accept the live daemon and reject exited, recycled-PID/start-mismatch and wrong-image fixtures.
  - **Source:** I-service.md, I-glue.md, state.rs

- [ ] **Reservation race**
  - **Do:** Start one worker, attempt a duplicate, kill it, then race two replacements. Inspect .lock and .endpoint.
  - **Expect:** Duplicate is Busy; inherited HANDLE identity/DACL validates and inheritance clears; crash releases reservation but leaves marker; one replacement wins; stale cleanup cannot delete the new marker.
  - **Source:** I-ipc.md, I-fix1.md

- [ ] **Breakaway worker**
  - **Do:** Launch supervisor outside a job, inside a breakaway-allowed job, and inside a denied job; inspect with Process Explorer.
  - **Expect:** First two yield an out-of-job, no-console worker that survives restart; denied/still-in-job fails before HELLO/START with no endpoint. Only reservation + three NUL handles cross creation; output goes to worker.log.
  - **Source:** I-ipc.md, I-fix1.md

- [ ] **Adoption, TERM, KILL**
  - **Do:** In web start two sessions; in each run a shell + grandchild and record PIDs. End only spawnd.exe, reconnect, then TERM and KILL one session.
  - **Expect:** Workers/shells survive and adopt. TERM returns within two seconds and delivers bounded ETX/Ctrl+C under saturated input; KILL flushes ack then removes only that worker/job tree; crash triggers kill-on-close cleanup.
  - **Source:** I-ipc.md, I-fix1.md, SESSIOND.md

- [ ] **Lifecycle bounds**
  - **Do:** Open seven lifecycle clients without writing; issue a valid request; send 0-, 16- and 18-byte requests and malformed acknowledgements.
  - **Expect:** Silent clients expire near 100 ms; valid request completes within two seconds; resources stay capped; cleanup never touches a sentinel process.
  - **Source:** I-ipc.md, endpoint/windows.rs

- [ ] **Command resolution**
  - **Do:** Run cmd.exe, powershell.exe, a native EXE and extensionless claude resolving to claude.cmd from a path with spaces/non-ASCII; pass two words, a&b, %, !, quotes and a trailing backslash.
  - **Expect:** PATH/PATHEXT, batch wrapping, argv/environment, output, exit and reservation cleanup are correct; no injection or ERROR_BAD_EXE_FORMAT.
  - **Source:** I-ipc.md, I-core-daemon.md

- [ ] **ConPTY replay**
  - **Do:** Run live/replay cases: CR/LF, right-margin wrap, alternate screen, erase, title/modes, wide/combining text, active 80×24→132×40 resize, Ctrl+C, reattach and scrollback rotation.
  - **Expect:** Live and replay emulator states match; resize/input stay responsive; no hang, corrupt history or duplicate committed lines.
  - **Source:** I-ipc.md, I-fix1.md, SESSIOND.md

- [ ] **Foreground labels** _(NTH)_
  - **Do:** Exercise shell-only, nested CLI, compiler/background helpers and rapid exit races while watching labels.
  - **Expect:** Basename only, .exe removed, ≤64 characters; races yield None or advisory false positives, never paths/args or lifecycle effects.
  - **Source:** I-service.md, I-ipc.md

- [ ] **Secret memory** _(NTH)_
  - **Do:** Run secret-memory tests normally and inside a constrained job.
  - **Expect:** VirtualLock succeeds or fails non-fatally; teardown zeroizes before VirtualUnlock; no dump-exclusion claim.
  - **Source:** I-ipc.md, SESSIOND.md


## Files and credentials

- [ ] **Private ACLs**
  - **Do:** After standard-user possession run Get-Acl "$env:LOCALAPPDATA\spawn" | Format-List * and icacls.exe "$env:LOCALAPPDATA\spawn" /T /C; repeat for state, logs, credentials, locks, temps, scrollback and uploads.
  - **Expect:** Current SID owns every private object; inheritance disabled; no Users/Authenticated Users/Everyone allow ACE; config is LocalAppData, not Roaming or %USERPROFILE%\.local\state.
  - **Source:** I-core-daemon.md, platform/windows.rs, daemon/CLAUDE.md

- [ ] **Credential file**
  - **Do:** Run cargo test --locked --target x86_64-pc-windows-msvc creds:: -- --nocapture; approve two browser pins, restart and verify the same account.
  - **Expect:** Complete-file round trip handles two pins + 12 KiB token; no Credential Manager write; locks exclude; malformed/oversize refused; stale temps/interrupted replacement recover without losing unknown fields.
  - **Source:** I-core-daemon.md, R3-files-and-leaves.md

- [ ] **Fail-closed objects**
  - **Do:** Run cargo test --locked --target x86_64-pc-windows-msvc platform:: -- --nocapture; loosen/inherit ACL, change owner, substitute a junction; add symlink/other reparse cases when Developer Mode permits.
  - **Expect:** Existing objects are rejected, never repaired; junction runs without Developer Mode; wrong owner, broad/inherited ACL and every reparse point fail closed.
  - **Source:** I-core-daemon.md, I-glue.md, I-fix1.md

- [ ] **File publication**
  - **Do:** Run cargo test --locked --target x86_64-pc-windows-msvc host_files:: -- --nocapture, host_preview:: and upload::; concurrently swap an intermediate directory for a junction and pre-create collision names.
  - **Expect:** No escape/overwrite; no-clobber preserves both files; overwrite changes only destination; identity catches swaps; NTFS hard-link staging/fallback copy preserve content; abandoned temps clean up.
  - **Source:** I-core-daemon.md

- [ ] **Filesystem support**
  - **Do:** Repeat private-object/publication tests on FAT/exFAT; repeat essential identity/publication on ReFS only if it will be supported.
  - **Expect:** FAT/exFAT and unsupported security queries fail closed. ReFS is unclaimed until it passes. UNC upload roots and device namespaces remain rejected in v1.
  - **Source:** I-core-daemon.md, R3-files-and-leaves.md

- [ ] **Client path model**
  - **Do:** From web/mobile browse, create, rename, remove and select cwd under C:\Users\<name>, D:\..., mixed separators and supported \\server\share\home; try CON.txt, NUL and trailing dot/space.
  - **Expect:** Backslashes round-trip; containment is case-insensitive and capped at home; breadcrumbs/parents are correct; reserved leaves are refused.
  - **Source:** I-web-frontends.md, I-mobile-frontends.md


## Self-update

- [ ] **Task N→N+1**
  - **Do:** Install signed N in Task mode, keep a session live, serve signed N+1, run spawnd --server https://<test-origin> update. Record task, supervisor, worker and shell PIDs; list %LOCALAPPDATA%\spawn\bin.
  - **Expect:** Refuses without a fresh breakaway marker; otherwise no-window handoff waits, swaps the complete pair, /Runs the exact task, preserves worker/session PIDs and completes probation. Names use .prev.exe, .tmp.<pid>.exe, .failed.<pid>.exe.
  - **Source:** I-core-daemon.md, I-glue.md, I-desktop.md

- [ ] **Run N→N+1**
  - **Do:** Repeat after spawnd possess --service-mode run.
  - **Expect:** Watchdog waits behind spawnd.updating, resumes only after watchdog-update-ready, owns the new supervisor, keeps sessions and never starts a mixed pair.
  - **Source:** I-service.md, I-glue.md

- [ ] **Rollback faults**
  - **Do:** Inject registration, spawn, helper/breakaway, locked-worker, second-rename, truncation/hash and process/power failures.
  - **Expect:** No pre-hash execution; bounded retries; complete old pair restored where possible; probation revert restores manager/task; failed images clean up; credentials/state survive; no known mixed pair or stopped manager is stranded.
  - **Source:** I-core-daemon.md, I-glue.md, I-dist.md

- [ ] **Defender + EDR**
  - **Do:** Repeat N→N+1 and rollback with Defender real-time protection; use representative enterprise EDR if available.
  - **Expect:** No unhandled ERROR_SHARING_VIOLATION; repeatable Defender failure blocks release. Record EDR product/version and fix or exclude it from support.
  - **Source:** I-core-daemon.md, I-glue.md, I-fix1.md


## Desktop app

- [ ] **Windows desktop build**
  - **Do:** GitHub → Actions → Desktop artifacts → Run workflow after signing provisioning. On Windows, in desktop/, run npm ci, npm run build and cargo test --manifest-path src-tauri/Cargo.toml --locked --target x86_64-pc-windows-msvc.
  - **Expect:** Desktop + linked daemon compile with no Unix import or COM ABI mismatch; Windows tests pass.
  - **Source:** I-desktop.md, desktop.yml

- [ ] **Signing sequence**
  - **Do:** Verify no-bundle build → inner signing → NSIS bundle → outer signing; inspect the bundle directory.
  - **Expect:** The signed inner spawn-desktop.exe is preserved; exactly one *-setup.exe, no MSI; both signatures Valid, expected publisher and timestamped before upload.
  - **Source:** I-desktop.md, RELEASE.md

- [ ] **WebView2 + install**
  - **Do:** From the no-WebView2 snapshot, double-click the canonical setup EXE as standard user; repeat with the runtime installed and once offline. Inspect Settings → Apps → Installed apps.
  - **Expect:** currentUser install has no UAC and appears per-user; existing runtime works; bootstrapper downloads when needed; offline failure is intelligible.
  - **Source:** I-desktop.md, tauri.windows.conf.json

- [ ] **WebView security**
  - **Do:** Launch installed app + DevTools. Navigate local wizard → SPAWN D origin; open same-origin, outside-origin and target=_blank links; inspect navigator.userAgent and CSP console.
  - **Expect:** Wizard at http://tauri.localhost/; SPAWN D stays inside; external links use system browser; CSP clean; live Edge/WebView2 UA has exactly one SpawnDesktop/<version> token and acceptable client hints.
  - **Source:** I-desktop.md

- [ ] **Deep links**
  - **Do:** With app stopped: Start-Process 'spawn://auth/oauth?code=test&state=test'. Repeat during real OAuth while app runs, plus invalid host/path/state forms.
  - **Expect:** One process/tray icon; stopped path reaches getCurrent() once; running path reaches onOpenUrl() once and fronts the window; invalid callbacks rejected.
  - **Source:** I-desktop.md

- [ ] **Possess + repair**
  - **Do:** Possess through desktop on a fresh VM; keep a PTY session open and trigger repair/update with existing, partial and running daemon pairs.
  - **Expect:** Only a verified complete pair installs; no half-pair remains; existing updates belong to spawnd update; hashes converge, task is healthy and session survives without sharing violation.
  - **Source:** I-desktop.md

- [ ] **Diagnostics**
  - **Do:** SPAWN D tray → Settings → Diagnostics with current status --json, then fixtures missing optional service fields and containing overlong diagnostics.
  - **Expect:** Uses exact manager, /TN name and daemon stdout/stderr paths; old/absent fields degrade safely; text is bounded; desktop never infers a Windows log path.
  - **Source:** I-desktop.md, I-glue.md

- [ ] **Desktop secrets**
  - **Do:** On the merged tree, sign in/possess, restart, test concurrent secret access and inspect desktop secret files with Get-Acl and junction substitutions.
  - **Expect:** Token and seed persist by server scope in protected secret_file storage; current-SID DACL/reparse rules hold; no Credential Manager write or 2,560-byte limit remains.
  - **Source:** I-desktop.md_reconcile_notes.md

- [ ] **DPI + tray behavior**
  - **Do:** At 100/125/150/200% and mixed DPI, test tray/app/installer icons, centering, Snap, focus, Close, Alt+F4, Settings, Quit and relaunch.
  - **Expect:** Sharp, color-correct layers; Close/Alt+F4 hide to one tray icon; Quit exits only companion; daemon/task continue; no clipping or template inversion.
  - **Source:** I-desktop.md

- [ ] **Updater + uninstall**
  - **Do:** Publish signed beta N+1; Settings → Check for updates; tamper with EXE/signature and publish an older version. Then Settings → Apps → Installed apps → SPAWN D → Uninstall.
  - **Expect:** Passive no-UAC update validates Tauri signature, restarts once and preserves protocol/credentials/preferences; tamper/downgrade fail; uninstall removes app/protocol but preserves daemon/task/sessions.
  - **Source:** I-desktop.md


## Web and mobile surfaces

- [ ] **Release-state gate**
  - **Do:** In Edge open / and /download with no Windows daemon metadata, daemon-only metadata, then complete daemon + desktop metadata.
  - **Expect:** No metadata defaults to Windows (WSL) and requests no DMG/EXE; daemon-only exposes native PowerShell and says desktop unavailable; complete metadata downloads the canonical setup EXE, never a DMG.
  - **Source:** I-web-frontends.md

- [ ] **Deferred download**
  - **Do:** Hold /api/release; click Windows slab; switch to macOS/WSL; release response; repeat reverse. Test widths 320, 390, 768 and desktop.
  - **Expect:** Deferred click is stamped to its original platform or cancelled, never cross-downloads; three tabs/four-card layout do not overflow.
  - **Source:** I-web-frontends.md, R6-frontends.md

- [ ] **Playwright flows**
  - **Do:** In web/: npx playwright test tests/e2e/download.spec.ts tests/e2e/onboarding.spec.ts tests/e2e/settings-modal.spec.ts tests/e2e/device-approval.spec.ts tests/e2e/possess-key-check.spec.ts tests/e2e/folder-picker.spec.ts tests/e2e/files.spec.ts.
  - **Expect:** Browser flows execute—not just typecheck—and download staging, shared host gates and Windows paths pass.
  - **Source:** I-web-frontends.md, R6-frontends.md

- [ ] **Cross-client contract**
  - **Do:** Edge: onboarding, bare /device, /legion → Add machine. iOS/Android: About, onboarding, Legion/detail/facts/files and Share. Compare release responses without/with daemon.targets.windows-x86_64; copy every target command.
  - **Expect:** Target count changes two→three only when native Windows is live; one manifest gate everywhere; native command is exact; WSL has no smart quotes/newlines; label is Windows · x64; sorting/icons generic; copy/share advances only intended flow.
  - **Source:** I-web-frontends.md, I-mobile-frontends.md

- [ ] **Recovery by host OS**
  - **Do:** From iPhone/Mac and Android, open failed update recovery for a native Windows host and a WSL/Linux host.
  - **Expect:** Controlled host OS—not controller OS—chooses PowerShell for Windows and curl ... install.sh | sh for Linux/WSL.
  - **Source:** I-web-frontends.md, I-mobile-frontends.md

- [ ] **WSL lifecycle**
  - **Do:** In WSL2 add [boot] systemd=true to /etc/wsl.conf, run wsl --shutdown, install through WSL, then create/test logon action wsl -d <distro> --exec true and sign out/in.
  - **Expect:** spawnd.service runs in WSL; distro starts at Windows sign-in; host returns online without manual WSL launch; native and WSL registrations stay distinguishable.
  - **Source:** R6-frontends.md


## Security, Defender and firewall

- [ ] **Reputation surfaces**
  - **Do:** Download unsigned debug, new production-signed daemon and signed NSIS through Edge and PowerShell on clean snapshots; inspect Properties → Digital Signatures, SmartScreen, Defender and Smart App Control.
  - **Expect:** Production files show exact verified publisher + timestamp but may be initially unrecognized; unsigned files never ship; docs claim no bypass.
  - **Source:** I-dist.md, R4-distribution.md

- [ ] **Enterprise policy**
  - **Do:** Test default policy, RemoteSigned/AllSigned, documented process-scoped -ExecutionPolicy Bypass, GPO policy, Constrained Language and WDAC/AppLocker.
  - **Expect:** Supported policy runs signed files; enterprise controls fail visibly and are not bypassed; inspect-then-run works where allowed.
  - **Source:** I-dist.md

- [ ] **Firewall + ICE**
  - **Do:** On Private/Public profiles, admin/standard user, accept/deny/dismiss first-listen prompt. As admin run the exact New-NetFirewallRule/Remove-NetFirewallRule commands in docs/RELEASE.md.
  - **Expect:** No silent installer rule or any-program/Public rule; program-scoped Private UDP 50000–50999 enables direct ICE; removing/blocking still connects through outbound UDP TURN; record actual rules.
  - **Source:** I-dist.md, I-glue.md, RELEASE.md

- [ ] **Managed standard user**
  - **Do:** Use a domain/policy-managed standard-user snapshot denying task creation and possibly Run keys; possess without admin.
  - **Expect:** No elevation; task denial offers Run watchdog when allowed; if both are blocked, failure is clear and foreground/no-service remains explicit.
  - **Source:** R1-process-model.md, I-service.md

- [ ] **Session + third-party EDR** _(NTH)_
  - **Do:** Test RDP/local fast-user switching, lock/unlock, battery transition and a third-party EDR.
  - **Expect:** IgnoreNew prevents duplicates; supported account/session behavior is documented; failures identify policy/product.
  - **Source:** R1-process-model.md, I-core-daemon.md


## Release verification

- [ ] **Authenticode + hashes**
  - **Do:** For both daemon assets run Get-AuthenticodeSignature, signtool.exe verify /pa /all /v and Get-FileHash -Algorithm SHA256; repeat for inner desktop EXE and outer setup EXE.
  - **Expect:** Status=Valid; daemon subject exactly WINDOWS_SIGNING_SUBJECT; desktop subject exactly WINDOWS_SIGNING_SUBJECT; all timestamped; hashes cover post-signing bytes; one-byte mutation breaks proof.
  - **Source:** I-dist.md, I-desktop.md, workflow files

- [ ] **Signed-pair smoke**
  - **Do:** pwsh -NoProfile -File scripts/smoke-install-prebuilt.ps1 -SpawndPath <release-spawnd> -WorkerPath <release-worker>.
  - **Expect:** Local FastAPI health, script parse, EXE response names, hashes, execution, idempotent rerun and cleanup pass with useful failure logs.
  - **Source:** I-dist.md

- [ ] **Desktop publication proof**
  - **Do:** Before server identity starts, place non-empty /var/www/spawnd/desktop/SPAWN-D_<version>_windows-x86_64-setup.exe; query /api/release absent/empty, then present.
  - **Expect:** Windows desktop omitted for absent/empty; included only for exact non-empty file. Daemon target appears only with a valid EXE pair + manifest.
  - **Source:** I-web-frontends.md, release.py, RELEASE.md

- [ ] **Public Windows assets**
  - **Do:** From Windows fetch /api/install/spawnd/windows-x86_64, /api/install/spawn-worker/windows-x86_64, /api/install/manifest.json, /install.ps1, /desktop/latest.json and setup EXE.
  - **Expect:** Logical URLs extensionless; response filenames .exe; hashes agree across release/manifest/bytes; latest.json has exactly three platforms + canonical Windows URL/signature; ranges and lengths work.
  - **Source:** I-core-daemon.md, I-dist.md, I-desktop.md

- [ ] **Post-deploy verification**
  - **Do:** Run scripts/verify-prebuilts.sh https://spawnd.dev and scripts/verify-release.sh https://spawnd.dev; independently run irm https://spawnd.dev/install.ps1 | iex on the clean VM.
  - **Expect:** Five pairs, offline manifest signature, public bytes, all product identities and three updater signatures pass; public Windows install retrieves those exact signed bytes.
  - **Source:** I-dist.md, RELEASE.md

- [ ] **Chronology audit**
  - **Do:** Audit timestamps: signed daemon PEs → SHA256SUMS → offline daemon manifest; signed desktop inner/outer PEs → offline Tauri signatures → payloads → manifests; artifacts/server before client controls.
  - **Expect:** No manifest hashes pre-signing bytes; no PE changes after signing; no native UI points to missing/unsigned daemon or desktop artifacts.
  - **Source:** RELEASE.md


## What still blocks confidence

Carried over from the port handoff: known gaps that no amount of running the
rows above will close. One is struck because it has since been fixed in the
tree.

- **Targeted CTRL_BREAK_EVENT and shell-only session jobs are not implemented; R2 ETX + worker-job policy is intentional.**
  - **Owner:** Daemon IPC / portable-pty dependency owner
  - **Closes when:** When portable-pty exposes Windows creation flags and atomic PROC_THREAD_ATTRIBUTE_JOB_LIST beside the pseudoconsole attribute, retain shell creation identity, add the proved no-window console agent and replace the policy without bare-PID fallback.
- **No serialized live-process Windows self-update harness; only unit/synthetic coverage and the manual procedure exist.**
  - **Owner:** Daemon update + Windows CI
  - **Closes when:** Add or record a repeatable N→N+1/probation-revert harness using an installed pair under Defender, Task and Run modes, including sharing failures.
- **Native junction/reparse-swap tests have not run.**
  - **Owner:** Daemon platform/files + Windows CI
  - **Closes when:** Run the junction test with Developer Mode off, then symlink/other reparse and concurrent-swap cases when privilege permits. Never skip every reparse case because symlink creation failed.
- **Rewritten Windows Playwright specs were typechecked before the merge and need retained runtime evidence.**
  - **Owner:** Web owner / browser CI
  - **Closes when:** Execute the exact matrix command on a browser-capable runner and complete native-Windows Edge smoke.
- **Windows ARM64 is deliberately absent.**
  - **Owner:** Programme owner + daemon/dist/desktop
  - **Closes when:** V1 must reject it before download. Add only with a distinct windows-aarch64 target, native runtime/CI/ConPTY/service/update/signing/desktop matrix and artifacts; never alias x64.
- **Mobile About omits a native PowerShell prebuilt-only smoke line.**
  - **Owner:** Mobile + installer
  - **Closes when:** After PowerShell 5.1/7 proves the final -PrebuiltOnly scriptblock form, add the exact invocation or document that ordinary Windows installation is always prebuilt-only.
- ~~The desktop signing job has no windows-code-signing environment and verifies a subject fragment rather than the daemon’s exact subject variable.~~
  - **Fixed.** `desktop.yml`'s Windows job now declares
    `environment: windows-code-signing`, and both workflows compare the
    complete `WINDOWS_SIGNING_SUBJECT` for exact equality with the same
    signtool verification. Nothing is left for this row but to confirm it
    on the first real signing run.
- **A direct Scheduled Task action may flash a console on a real PC.**
  - **Owner:** Daemon service/distribution
  - **Closes when:** If any supported Windows 11 build flashes at logon, /Run or crash restart, block release and add a signed GUI-subsystem launcher—never PowerShell, cmd or wscript.
