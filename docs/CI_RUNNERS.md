# SPAWN D CI runners

GitHub schedules the workflows and retains their logs and artifacts. Every job
executes on our own hardware. There is no paid hosted-runner fallback. A missing
platform stays queued and cannot satisfy a release gate.

## Pool map

| Label | Platform | Purpose | Host |
| --- | --- | --- | --- |
| `spawn-linux-build` | Linux x64, Ubuntu 22.04 | Full tests, canary, Linux release and diagnostics binaries | Multivac |
| `spawn-linux-android` | Linux x64 with KVM | Native Android Release app and emulator acceptance | Multivac |
| `spawn-linux-control` | Linux x64 | Resolve candidate/baseline and aggregate acceptance | Minivac |
| `spawn-linux-wait` | Linux x64 | Wait for source CI and prebuilt publication | Minivac, two slots |
| `spawn-linux-release` | Linux x64 | Protected release plan/deploy/OTA and artifact publication | Minivac |
| `spawn-linux-arm64` | Linux ARM64, Ubuntu 22.04 | ARM64 daemon/worker binaries | ARM64 Linux VM on Minimac, pending provisioning |
| `spawn-macos-build` | macOS ARM64 | Native iOS acceptance and unsigned branch binary builds | Minimac, pending Xcode/storage and standard CI account |
| `spawn-macos-release` | macOS ARM64 | Protected Apple signing, Mac/Intel daemon and desktop builds | Minimac, separate standard release account |
| `spawn-windows-build` | Windows x64 | MSVC tests and unsigned installer rehearsal | Dedicated Windows host, pending |
| `spawn-windows-release` | Windows x64 | Protected Authenticode binary and desktop builds | Same Windows host, separate standard release account |

Labels describe capabilities, not an assertion that an unfinished machine is
ready. The native Windows and Apple signing gates still run on those operating
systems. Linux executables retain the Ubuntu 22.04/glibc 2.35 floor. The existing
EAS store-build command still uses EAS; moving GitHub jobs does not change that
service's build quota, signing credentials, or distribution process.

Labels are routing information, not authorization. Persistent Mac and Windows
release services install a pre-job hook outside the checkout before they start.
It rejects anything except the approved prebuilt/desktop workflows on master,
using GitHub's reserved job context variables, before checkout or any job steps.
Keep that hook and its service configuration intact. Build accounts cannot read
or modify the release account's runner directory. The protected signing
environments remain a second gate. Linux release containers are discarded after
each job, so a previous branch job cannot leave files or processes for a release.

## Linux isolation and supervision

`scripts/ci/runner-linux.Dockerfile` builds the runner image. The version and
SHA256 hashes come from GitHub's repository runner-download API and are recorded
in `runner-versions.json`. Updating them requires checking the new archive hash.
Runner automatic updates remain enabled; refresh the image regularly.
The image includes Python 3.13 for the evidence tools; Ubuntu 22.04's system
Python 3.10 cannot run them. Jobs explicitly install their Node version.
Android native dependencies require both CMake and Ninja. The image includes
`ninja-build`; native acceptance also installs it when absent from an older
disposable image, after checking the container-isolation marker. This bootstrap
does not install packages on the host.

The operator-side `runner-pool.py` uses the existing authenticated `gh` CLI to
mint a just-in-time credential for each container. The GitHub administration
credential stays on the operator machine. Only the one-job runner configuration
crosses SSH on stdin; it is removed from the environment by the runner before
job execution. No operator home, checkout, SSH key, Docker socket, or privileged
container is exposed to a job. Sudo affects only that job's container.

Each runner receives one job and then deregisters. The supervisor captures its
diagnostics, removes only the named, ownership-labelled container, and starts a
fresh replacement. Cleanup failure stops the pool instead of reusing it. A
supervisor restart retires its recorded containers before accepting more jobs;
restart it between active jobs. The state directory is private and contains
runner IDs and diagnostics, not the GitHub administration credential. Archive or
remove old completed diagnostics periodically; active records must be preserved.

`pools.json` bounds CPUs, memory and concurrency. Multivac workspaces use tmpfs
inside those memory limits, including `/tmp` and downloaded toolchains; their
combined size leaves room for compiler/emulator memory. The two large jobs are
capped at 88 GiB in total on Multivac's 128 GiB host.
Only the Android pool receives `/dev/kvm` and its actual supplementary group.
It never changes the host's device permissions. Minivac coordination jobs use
ordinary disposable container storage. Waiting jobs have separate slots to
avoid blocking the builder/publisher they are waiting for.

Build the image on each Linux Docker host, or transfer the same saved image:

```bash
docker build -f scripts/ci/runner-linux.Dockerfile \
  --build-arg RUNNER_VERSION=2.337.0 --build-arg RUNNER_ARCH=x64 \
  --build-arg RUNNER_SHA256=70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613 \
  -t spawnd-ci-linux:2.337.0 scripts/ci
```

Install `runner-pool.py` and `pools.json` in
`~/.local/share/spawnd-ci/controller/`, and copy `spawnd-ci-pool.service` into
`~/.config/systemd/user/`. The operator's `gh` authentication needs repository
administration for runner registration. SSH aliases must resolve noninteractively.

```bash
systemctl --user daemon-reload
systemctl --user enable --now spawnd-ci-pool.service
journalctl --user -u spawnd-ci-pool.service -f
gh api repos/levy-street/spawn/actions/runners
```

User lingering must be enabled for startup without an interactive login. The
current controller runs on DREAM, whose existing user already has lingering.
Stopping this service stops only its recorded CI containers and registrations.

## Mac setup

Install full Xcode, its selected iOS Simulator runtime, Node 22, Python 3.13,
Rust and coturn. Xcode and the build workspace need substantially more room than
the 19 GiB free found during the initial Minimac inspection. Select Xcode and
complete its first-launch components/license as the administrator.

Use different **standard** macOS accounts for build and release. Keep the build
account away from operator and release keychains, credentials and writable
shared tooling. Do not run either service as the operator's `oem` account.
From each account's logged-in session, run:

```bash
bash scripts/ci/install-macos-runner.sh build   # release for the other account
```

The script verifies the archive hash and platform tools, prompts for a short-lived
repository runner registration token, and installs the official launchd service.
Keep the Simulator account's GUI session available. A dedicated ARM64 Linux VM
can provide the separate `spawn-linux-arm64` label; macOS itself must never be
labelled as Linux. Provision that pool with the matching ARM64 runner archive.

## Windows setup: outbound connections only

The official runner service maintains outbound HTTPS connections to GitHub and
receives jobs through them. No inbound SSH, RDP, webhook endpoint, port forwarding,
or polling script of our own is required. Jobs also need outbound access to
dependency registries, artifact endpoints, and the existing signing services.

Create separate standard local accounts for build and release on the dedicated
Windows machine. From an elevated PowerShell, with this directory copied locally:

```powershell
.\scripts\ci\install-windows-runner.ps1 -Role build -InstallTools
.\scripts\ci\install-windows-runner.ps1 -Role release
```

`-InstallTools` provisions machine-wide Git, PowerShell 7, .NET 8, Azure CLI and
the Visual Studio 2022 C++ workload through winget, preserving installed package
versions. PowerShell uses the machine-wide MSI, with remoting disabled. Setup
checks the .NET 8 SDK, VS 2022 C++ tools and a complete x64 Windows SDK using
machine paths. Each runner's `.env` records these paths, with Git Bash ahead of
the System32 WSL launcher and its own profile's `.dotnet\tools` for AzureSignTool.
Newly installed tools are available even when the service manager still has the
PATH from boot. Rust, Node and uv are installed by the existing workflow actions.
Setup requests each standard account's credential
and a short-lived repository runner registration token (GitHub Settings →
Actions → Runners → New self-hosted runner). It verifies the runner archive,
restricts its directory ACL to that account/SYSTEM/administrators, and installs
an automatic Windows service with restart-on-failure. It refuses an administrator
job account, account reuse between roles, or overwriting an existing runner.
An operator automation may supply `-ServiceCredential` as a `PSCredential` and
`-RegistrationToken` as a `SecureString` instead of using the prompts. Generate
or obtain these in memory; never put their plaintext values in command arguments
or files. The installer passes secrets through GitHub's temporary
`ACTIONS_RUNNER_INPUT_*` environment inputs, which the runner masks and removes.
The operator's administration credential must remain outside both CI accounts.

Create each account's Windows profile before starting its service, and restrict
the profile to that account, SYSTEM and administrators. After setup, test tool
access and profile/runner isolation under both actual service identities, and
test the installed release hook against master and rejected branch/PR contexts.
Record the plugged-in sleep setting, disable automatic sleep, and verify service
recovery only while the runner is idle. If setup fails, inspect its directory,
service and GitHub registration before resuming; do not rerun over partial state.

The service uses its own runner credential thereafter; it never needs a GitHub
PAT. Keep both role accounts isolated. Signing still requires the protected
`windows-code-signing` environment, its master-only branch policy, the existing
Azure federated identity, and the configured certificate and timestamp checks.
An online Windows runner is not evidence that MSVC, installer or signing tests
passed: those workflows must complete on the candidate.

## Acceptance and release gates

`check-self-hosted.py` rejects hosted literals and unknown routing expressions;
its counterexample tests and the pool ownership tests run in `test-all.sh`.
The Android disk preflight uses `--self-hosted`, which measures free space and
never deletes installed tooling. Its former hosted-only cleanup path cannot run
on a self-hosted machine. KVM access is provisioned once rather than changing
udev rules from a workflow.

Candidate/baseline binding, full native cases, canary soak, cleanup evidence,
exact master-push Linux/Windows results, signing environments and publication
order stay required. GitHub artifact/cache storage is separate from runner
compute; this migration does not change its accounting or retention rules.

References: [GitHub self-hosted runners](https://docs.github.com/en/actions/reference/runners/self-hosted-runners),
[service setup](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application),
and [runner REST API](https://docs.github.com/en/rest/actions/self-hosted-runners).
