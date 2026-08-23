# spawnd — launch kit

Ready-to-post copy. Deadpan, total commitment; every claim survives a threat-model diff.
Messaging locked: **the relay is a fallback only — TURN carries ciphertext it cannot decrypt**;
the terminal path is **end-to-end encrypted, browser to daemon**. Lead with the strong claim.

Live surfaces to link:
- Landing: `https://spawnd.dev`
- Threat model / trust: `https://spawnd.dev/veil`
- Install: `https://spawnd.dev/download`
- Hero image for cards: `https://spawnd.dev/possession.png`

---

## One-liners (bios, stickers, headers)

- **Possess your machines.**
- Demon spawn for every machine you own.
- It answers only to you.
- We introduce. We never listen.
- Zero open ports. Zero trust. Full possession.
- Consensual. Auditable. Revocable.
- A daemon on every host you own — and a server that can't hear a word it says.

**X / GitHub bio:** `Possess your machines. Open-source control plane for CLI coding agents — the server can't read your terminal. Consensual. Auditable. Revocable.`

**README first line:** `spawnd — demon spawn for every machine you own. Summon CLI coding agents from any browser; the server that coordinates it is structurally unable to read your terminal.`

---

## X — launch thread (post as written)

**1/**
today we're releasing a demon that possesses your computers.

this is not a metaphor. it is a daemon. you install it. it possesses the host. it answers only to you — we made sure we *can't* hear it even if we wanted to.

spawnd. zero open ports. zero trust. full possession. 🧵

**2/**
one line possesses a host:

`curl -fsSL https://spawnd.dev/install.sh | sh`

then a pairing ceremony: the daemon prints a key fingerprint — a sigil — you verify it once, and possession is complete. consensual, auditable, revocable. one click and the socket dies.

**3/**
your terminal is end-to-end encrypted, browser to daemon, over WebRTC.

the coordinating server carries signaling only — there is no server code path for terminal content. when NAT forces a relay, TURN carries ciphertext it can't decrypt. the server introduces you. it never listens.

**4/**
the hosts dial out. no inbound ports, no exposed SSH, no tailnet. nothing reaches in; the demon only reaches out.

and your sessions are revenants: kill the daemon mid-session, restart it, the worker is re-adopted, scrollback intact. the daemon dies; the work does not.

**5/**
every session is a real shell. claude, codex, opencode, aider, or any custom CLI is a visible shortcut inside it. summon one on your GPU rig from your phone at dinner, on the subscription you already pay for. we never touch your API keys because we never *have* them.

**6/**
"but this is literally what malware does."

a botnet is possession *without* consent from a C2 that reads everything. spawnd is the inversion on every axis: you install it, you approve it, and the server is engineered to receive no terminal content.

we simply reversed every axis of evil.

**7/**
don't take our word for it — it's open source, and the threat model lists our own server as an adversary, because you should treat it as one.

read the veil → https://spawnd.dev/veil
possess your machines → https://spawnd.dev

(attach `possession.png` to tweet 1)

---

## Show HN

**Title:**
`Show HN: Spawnd – open-source control plane for CLI coding agents; the server can't read your terminal`

**First comment (founder account):**

I run Claude Code and Codex across a laptop, a dev box, and a GPU rig, and I was tired of every session being marooned on one machine. spawnd is a daemon you install on each host; you then open shells and run those CLIs from any browser, including your phone.

Architecture, because that's the interesting part:

- Terminal I/O runs on direct browser↔daemon WebRTC DataChannels. The server does auth, lifecycle, and signaling only — there is no server code path for terminal content, no transcript store. When NAT forces a relay, TURN carries ciphertext it can't decrypt.
- Hosts are outbound-only: no inbound ports, no exposed SSH, no tailnet. The daemon dials out over WSS.
- No central credential store — each agent CLI does its own login on the host, so we never hold your API keys.
- Session workers survive daemon restarts and are re-adopted, so a daemon update doesn't drop your live sessions.
- Signed signaling with first-contact key pinning: a hostile relay that substitutes a key to MITM the handshake is detectable (you compare a fingerprint once).

Honest limits, up front: the control plane still sees metadata and configuration listed in the threat model, including session directories, agent shortcut definitions, skill bodies, and host-agent check/install results; and a hosted web client is still JS the operator serves — reproducible builds + self-hosting are how you close that. The threat model documents all of it and names our own infrastructure as the adversary.

Etymology footnote for the name: "daemon" enters computing via Maxwell's demon, borrowed at MIT's Project MAC in 1963 for background processes doing work unseen. We just stopped euphemizing it.

Threat model: https://spawnd.dev/veil

---

## Reddit — one angle per parish

**r/selfhosted** — *Title:* `Spawnd: drive CLI coding agents on your own hardware from any browser — and here's exactly what the control plane can and can't see`
*Body:* Self-host the whole stack (daemon + control plane + optional TURN). Terminal traffic is E2E browser↔daemon; the server is signaling-only. Here's the honest metadata ledger [link /veil]. No inbound ports, outbound-only hosts, no tailnet. One click revokes a host and the socket dies.

**r/LocalLLaMA** — *Title:* `Turn your GPU rig into a possessed host — run jobs and drive any CLI agent from your phone`
*Body:* The rig runs the daemon; you attach from a browser to a real shell and watch nvtop in the terminal. Launch claude, codex, aider, or a custom CLI from visible shortcuts. Your hardware, your subscription, your keys — the server never has them.

**r/ClaudeAI** — *Title:* `Drive Claude Code from your phone, on your Max subscription, on your own hardware`
*Body:* Demo-first: summon Claude Code on your home box from a café. Real TUI, take-control from a second device mid-session, scrollback survives daemon restarts. Keep the theme in the flair, not the title.

**r/homelab** — *Title:* `No inbound ports, no tailnet, no reverse proxy — the daemon dials out`
*Body:* Networking elegance as the hook: outbound-only WSS, WebRTC for the data plane, ciphertext-only TURN fallback. One installer for macOS + Linux.

**r/programming** — *Title:* `Designing a control plane that can't read your data`
*Body:* Post the threat model as an essay [link /veil]; the product is the footnote. The doc names the operator as an adversary and documents residual risks openly.

---

## The canonical objection reply (pin everywhere)

> Fair — a botnet is possession without consent, run from a C2 server that reads everything. spawnd is the inversion on every axis: **you** run the installer, **you** approve the pairing ceremony against a key fingerprint, and the coordinating server is engineered to be unable to read the session — no code path for terminal content, and the threat model treats our own infrastructure as hostile. The daemon opens no inbound ports; it only dials out. Revocation is one click and the socket dies. And it's open source, so you don't have to take a single sentence of this on faith — including this one.

Short form: `a botnet is non-consensual possession with a C2 that reads everything. spawnd is consensual possession with a control plane that can't read your terminal. we simply reversed every axis of evil.`

---

## Voice guardrails (don't break the bit)

- Deadpan, total commitment. Never wink twice. No "😈 see what we did there."
- Every demonic term teaches a mechanism, or it gets cut.
- Precision survives the joke — this audience diffs your tweet against the threat model.
- Punch at the cloud-agent *model*, never at people.
- Occult-playful, not shock-edgy. Keep OAuth/PWA/error copy plain; the ceremony is sacred, the plumbing is boring.
- Banned words: seamless, empower, supercharge, unlock, revolutionize, game-changer, "AI-powered."

## Pre-launch checklist (gates the Oct 31 date)

- [ ] Repo flipped public (secret-scan history + rotate) — the launch claim depends on it
- [ ] Reproducible cross-machine build + self-host guide (verifiable-client story)
- [ ] Prod transactional email off `console` (signup verification actually sends)
- [ ] Terminal freeze under heavy output over TURN fixed (issue #1) before the hero demo clip
