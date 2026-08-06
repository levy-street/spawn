# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately, before public disclosure,
via GitHub's [private vulnerability
reporting](https://github.com/levy-street/spawn/security/advisories/new) on
this repository.

Include what you need to make the issue reproducible: affected component
(daemon, server, web client), version or commit, and the steps or proof of
concept. If you cannot reach the advisory form, open an issue asking for a
contact address without describing the vulnerability in it.

Expect an acknowledgement within a few days. Please give a reasonable window
to ship a fix before publishing; we will credit reporters who want it.

## What this project is trying to protect

spawn's threat model is documented in [docs/TRUST.md](docs/TRUST.md), and the
short version is unusual enough to state here: **the server is not trusted
with terminal content.** Sessions run on your machines, terminal bytes travel
endpoint-to-endpoint over WebRTC DataChannels, and the control plane is meant
to be able to schedule and relay without being able to read.

Findings are most valuable when they break one of these:

- **Server cannot read terminal content or history.** Any path that puts
  plaintext terminal bytes, scrollback, or uploaded file content where the
  server can observe them.
- **Server cannot impersonate a host to a browser, or a browser to a host.**
  Signed signaling binds RTC offers and answers to pinned Ed25519 identities;
  key substitution, downgrade to unsigned, or replay across sessions or scopes
  are all in scope.
- **Server cannot mint trust.** Device endorsements and host key
  introductions are verified against keys the operator approved out of band. A
  path where the control plane grants a device access the operator never
  approved is a serious finding.
- **Sealed trust bundles stay sealed.** They are encrypted under a secret
  derived in the browser from a passkey PRF; the server stores ciphertext.
- **Revocation actually revokes**, including transitively through endorsement
  chains, and promptly rather than at the next reconnect.

Also in scope, as ordinary vulnerabilities: authentication and session
handling, the pairing ceremony, privilege boundaries between accounts, and
remote code execution in the daemon or worker.

## Known and accepted

- A browser connecting to a host it has never verified, without an
  endorsement or an unlocked trust bundle, trusts the server's claimed host
  key on first contact. This is visible in the UI as "first contact" rather
  than "verified". Approving the device from a trusted browser, or unlocking
  saved trust with a passkey, removes it.
- The operator-hosted web client is served by the same control plane it is
  meant to be protected from. Verifiable/reproducible client delivery is
  tracked in the trust roadmap; until then a malicious server that serves
  backdoored JavaScript defeats browser-side guarantees. Self-hosting the
  server, or serving the client from a source you control, avoids this.
- `SPAWND_REQUIRE_SIGNED_RTC=0` disables signed-signaling enforcement on a
  daemon. It exists for recovery and is not a vulnerability by itself.

## Supported versions

This project is pre-1.0 and moves fast. Fixes land on `master`; there are no
maintained release branches yet.
