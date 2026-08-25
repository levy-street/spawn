# DESIGN — multi-account ↔ host linking, and easier Nth-host onboarding

Read-only investigation on branch `native-daemon-fixes-auto-update-daemon`, 2026-08-25.
All paths relative to `/Users/charliesaxton/dev/spawn`.

---

## 1. The current model (with evidence)

### 1.1 Ownership: one host, one account, forever

- `Host.owner_user_id` is a single NOT NULL FK — `server/spawn_server/models.py:362-368`.
- A host's Ed25519 identity key is **globally unique across all accounts**:
  `uq_hosts_host_public_key` (`models.py:470-475`). Two accounts can never each have a
  Host row for the same daemon identity.
- `HostKeyClaim` (`models.py:335-360`) is a **durable, first-writer-wins account claim on
  the host key**. Deleting a host deliberately *retains* the claim
  (`routes/hosts.py:697-746`, `_revoke_host`: "only this same owner can intentionally
  pair the stable key again"), and `docs/TRUST.md:329-333` states the rationale:
  deletion must not become an implicit cross-account key transfer. Any pairing attempt
  by a second account against a claimed key is refused as `key_conflict`
  (`routes/device.py:414-424, 470-493` in poll; `routes/device.py:826-834, 862-870` in
  approve).
- Host creation is the device-code ceremony: daemon `POST /api/auth/device/start` with
  its public key (`routes/device.py:97`), proves key possession
  (`routes/device.py:162`, `host_pair_possession.py`), a signed-in browser approves with
  a `SPAWN-HOST-PAIR-APPROVE-V1` signature (`routes/device.py:793`,
  `host_pair_approval.py`), the daemon polls and the server creates the Host owned by
  the approving user plus one `HostBrowserPin` (`routes/device.py:504-612`).
- The daemon token binds `(host_id, user_id)`: `auth.issue_daemon_token`
  (`auth.py:91-100`), and `daemon_principal` enforces
  `host.owner_user_id == payload["user_id"]` (`auth.py:227-247`). A host that changed
  owner would orphan its own daemon's token.
- **No cross-account access exists anywhere.** Every host/session/workspace route checks
  `owner_user_id == user.id` (214 occurrences across 24 server files —
  `grep -rn owner_user_id server/spawn_server | wc -l`); representative:
  `routes/sessions.py:226,242,276`, `routes/hosts.py:121` (`_get_owned_host`),
  `ws/browser.py:203`, `ws/host.py:367`. There is no member/share/grant table.
  `SessionAccess` in `web/src/lib/api.ts:346-350` is *skills per session*, not sharing.
  `legion.py` is per-account accounting only.

### 1.2 Daemon credential model: one record = one account

- `StoredCreds` (`daemon/src/creds.rs:59-83`): **one** `access_token`, **one**
  `host_id`, **one** `server_url`, **one** host key seed, plus `browser_pins`
  (max 32). One record per config dir; keyring entries are scoped per config-dir
  identity (`creds.rs:36-41`, `KEYRING_SCOPED_USER_PREFIX`).
- `--config-dir` / `SPAWN_CONFIG_DIR` is the documented isolation unit
  (`daemon/src/cli.rs:16-21`: "Give each spawn user or registration its own root to run
  fully isolated daemons side by side on one host"; `daemon/src/config.rs:30-33`).
- One daemon process holds one WSS connection registered as one host under one account.
  The `registered` frame carries a **singular** `account_id`
  (`server/spawn_server/ws/daemon.py:1588-1600`; `daemon/src/proto.rs:282-289`), which
  the daemon captures as `daemon_account: Option<[u8;16]>`
  (`daemon/src/run.rs:1417, 1451`). Browser pins and the revocation deny-list are
  delivered for that one account (`ws/daemon.py:1017-1044`).
- Two accounts through one daemon process is structurally impossible today: single
  token, single `account_id` scoping chain admission, single per-account deny-list,
  and a pin store whose adoption path verifies endorsements under that one account
  (`run.rs:1439-1461`, `creds.rs adopt_endorsed_browser_pins`).

### 1.3 Trust model: everything is account-scoped

- Anchors = the daemon's locally-held browser pins (`run.rs:1254-1258`); admission for a
  non-pinned browser is `find_valid_chain(account_id, anchors, revoked, sender, edges)`
  (`run.rs:1262-1270`; `daemon/src/endorsement_chain.rs:1-31`).
- Endorsements bind the account in the signed transcript (`SPAWN-ACCT-ENDORSE-V1`,
  `daemon/src/acct_endorsement.rs:44-52`), so an edge minted under account A verifies
  for no other account. Host and root introductions are likewise intra-account
  mailboxes with the firsthand-key rule (`routes/host_introductions.py:1-11`,
  `routes/root_introductions.py:1-20`).
- "A host trusted by two accounts" currently has **no representation**: the wire has
  one `account_id`, the daemon has one `daemon_account`, the local `BrowserPin` has no
  account field (only the optional `approval_proof.account_id`, `creds.rs:98-116`), and
  the deny-list is one account's revocations. `Host.supports_account_chains`
  (`models.py:377-381`) is a per-host one-way ratchet, also singular.
- Sessions are strictly `(owner_user_id, host_id)` (`models.py:855-866`); no session is
  visible to, or joinable by, another account.

### 1.4 The multi-instance answer that already exists

- `spawnd possess` with no `--config-dir` derives a **per-account instance dir**
  `<config>/spawn/<account_id>` (`daemon/src/possess.rs:1-15, 60-104`,
  `default_base` at `possess.rs:239-243`). A duplicate registration for an account that
  already has an instance is deregistered via `DELETE /api/hosts/self`
  (`routes/hosts.py:676-685`).
- Services are per-instance and non-colliding: `spawn-<8hex>.service` /
  `app.spawn.spawnd.<8hex>` from a SHA of the canonical config root
  (`daemon/src/service.rs:26-40, 84-86, 168-176`), with worker dirs and state dirs
  keyed the same way. `spawnd exorcise --all` enumerates and removes every instance
  (`possess.rs:141-176`).
- **So "run a second spawnd for the second account" is already mostly built** — each
  instance has its own keypair, so `HostKeyClaim`/`uq_hosts_host_public_key` never
  conflict. What actually blocks it today:
  1. **`possess` silently resumes when exactly one instance exists**
     (`possess.rs:37-56`): with account A registered, there is *no CLI path* to add
     account B short of hand-exporting `SPAWN_CONFIG_DIR` or `--config-dir`. The
     install one-liner ends in `exec spawnd possess` (`routes/install.py:680-682`), so
     re-running the curl also just resumes account A.
  2. **Nothing user-facing documents it.** `SPAWN_CONFIG_DIR` appears only in trust
     internals (`docs/TRUST.md:756,767`); no README/docs/web/mobile copy mentions
     multi-account on one machine.
  3. Both host rows default to the same name (system hostname,
     `daemon/src/login.rs:474`) — harmless across accounts (each account sees only its
     row) but confusing for one human running two accounts.

---

## 2. Options for (a): one machine usable from multiple accounts

### Option 1 — first-class multi-owner hosts (`host_members`)

**Schema.** `host_members(host_id FK, user_id FK, role owner|member, created_at)`;
`hosts.owner_user_id` stays as the primary owner (billing/limits/deletion authority) or
migrates into the table. `HostKeyClaim` must grow the same membership notion (its
first-writer-wins semantics is precisely what refuses a second account today).
`DeviceCode` conflict checks (`key_conflict` in start/approve/poll) change from
"claimed by someone else ⇒ deny" to "claimed and requester not a member ⇒ deny".

**Server.** Every one of the ~214 `owner_user_id` host/session authorization points
funnels into a membership helper (`_get_owned_host` → `_get_accessible_host`, and the
same in `ws/browser.py`, `ws/host.py`, sessions, workspaces, recent-dirs, agents
policy). Daemon-token semantics change: today's JWT binds `(host_id, user_id)` and
`daemon_principal` rejects on owner mismatch (`auth.py:245-246`) — it becomes
host-identity-only or "issued-by-member". Push/alert fan-out
(`ws/daemon.py:869-895`) must fan to all members.

**Wire.** `registered` / `host.browser_pins` become per-account lists:
`accounts: [{account_id, browser_pins, browser_device_ids, revoked_browser_keys}]`
(`ws/daemon.py:1588-1600, 2177-2198`; `proto.rs:282-320`), kept
backward-compatible with the singular fields for old daemons.

**Daemon.** `daemon_account` becomes a set; local `BrowserPin` gains an `account_id`
(credential-file schema migration in `creds.rs`); anchors partition per account so a
chain is only searched under the account whose anchors it claims
(`run.rs:1254-1270` already takes `account_id` — the change is choosing the right
partition per offer); deny-lists become per-account (union-only within each); session
attribution (who launched it) rides `session.create` for accounting.

**Trust bootstrap for the second account (the hard part).** Membership rows grant
*server-side* access only. For account B's devices to reach the PTY, B needs its own
anchor on the daemon — the mesh's soundness rule (P2, `docs/TRUST_DEVICE_MESH.md`
§3/§4) says an anchor enters only by an out-of-band ceremony. So "invite account B"
must end in a possess-style ceremony: B's browser verifies the host key out of band
(the `#k=` link fragment from the machine's terminal, `docs/TRUST_UX.md` §4, or a SAS
with the daemon), and the daemon pins B's device key under B's account. That means a
new daemon-participating ceremony *after* first registration — today the device-code
ceremony only happens at login (`login.rs`). Once one B-device is anchored, B's other
devices arrive via B's own account chains (unchanged machinery).

**Effort.** Server **L** (auth model touches everything, claim/dedup semantics,
migration), daemon **L** (credential schema, per-account partitioning, new ceremony),
wire **M** (compat rules), web+mobile **M** (invite/manage/roles UI, both frontends per
`CLAUDE.md`), docs **M**. Realistically the largest single feature since the mesh.

**Security.** Preserves E2E **iff** per-account anchors/chains/deny-lists never mix and
membership alone never admits a terminal connection — the server can add a member row,
but that row must remain inert until a client-side-verifiable ceremony anchors that
account. The residual cost is bug surface: cross-account confusion in the pin store or
chain scoping would be a trust regression, and today's code gets its safety partly from
the singularity of `account_id`.

**Product surface.** Also raises questions Option 2 never asks: do members see each
other's sessions and `foreground_command` labels (a real activity leak,
`models.py:878-882`)? Who may delete/update/revoke the host? Whose limits meter it?

### Option 2 — polish the multi-instance path (recommended first)

Each account gets its own daemon + host row on the machine; isolation is total and the
trust model is untouched. The gaps are UX, not architecture:

1. **`spawnd possess --new-account`** (daemon, S): force the staged-login path even
   when instances exist (`possess.rs:37-56` currently short-circuits at
   `existing.len() == 1`). With ≥1 instance, plain `possess` prints a one-line hint:
   "already possessed for <account>; to connect another account run
   `spawnd possess --new-account`".
2. **Install one-liner passthrough** (server, S): `curl …/install.sh | sh -s -- --new-account`
   forwards to possess (`routes/install.py` script tail, :660-682).
3. **`spawnd status` lists all instances** (daemon, S): today status reads one config
   dir; make the no-`--config-dir` form enumerate `account_dirs_with_creds`
   (`possess.rs:247-264`) the way `exorcise --all` already does.
4. **Docs + frontend copy** (S): a short "one machine, several accounts" section in the
   README/docs, and one sentence on the web `ConnectHostSection`
   (`web/src/components/hosts/connect-host.tsx`) and mobile
   `install-instructions.tsx` ("Already running SPAWN D for another account? Add
   `--new-account`."). Both frontends in the same commit (root `CLAUDE.md`).
5. Optional (S): default the host name to `hostname` unchanged — cross-account
   collisions are invisible to each account; skip server-side suffixing.

**Limitations (honest).** Two daemons supervise two worker trees (double the idle
footprint, double self-update churn); two host rows that are "the same machine" only in
the humans' heads; no cross-account sharing of a session or of host capacity buckets.
For "one human with work+personal accounts" these do not matter. For "a genuinely
shared team machine" they eventually will.

**Effort.** Daemon S, server S, web+mobile S, docs S. **Security: unchanged by
construction** — separate keys, separate pins, separate chains, separate claims.

### Option 3 — grow host/root introductions into cross-account sharing

Read both stores: they are strictly intra-account (`owner_user_id`-scoped mailboxes)
and their whole soundness rests on the recipient holding the *publisher's* device key
firsthand (`routes/host_introductions.py:1-11`; `routes/root_introductions.py:1-20`).
Account B holds no firsthand key of any of A's devices, so a cross-account
introduction is unverifiable by design — fixing that requires a cross-account SAS
ceremony between a device of A and a device of B, which *is* Option 1's trust
bootstrap. Option 3 therefore collapses into Option 1's hard part without its server
model. **Not a shortcut; discard.**

---

## 3. (b): one account, many hosts — what's actually hard, and the smallest fixes

What exists is already close to minimal:

- The Nth host is `curl -fsSL <server>/install.sh | sh` (`routes/install.py:143`,
  script ends in `spawnd possess`, :680-682) + **one** browser Approve on the
  `#k=`-carrying link (`web/src/app/device/page.tsx`, `connect-host.tsx:33-52`;
  `docs/TRUST_UX.md` §4).
- The device×host matrix is already collapsed: the approving browser broadcasts a
  signed host introduction (`connect-host.tsx` → `publishHostIntroductionBroadcast`,
  mesh R7), and every other device of the account admits itself to the new host via
  account chains (P4: one human check per *device*, not per host×device).
- Same-owner re-login reuses the pinned Host and its name
  (`routes/device.py:556-560`), and the possession/claim ordering makes re-pairing
  safe. The presence/reconnect half is out of scope here (covered elsewhere).

Remaining friction, enumerated:

1. **The approve step needs a browser you're signed into, on the URL the terminal
   printed.** Same machine: fine (`possess` opens it). Headless server via SSH: you
   must copy the URL to another device by hand; on a phone that means retyping.
2. **Nothing notifies you.** The terminal waits, polling; if the operator walks away or
   the printed URL scrolls off, the ceremony expires (TTL, `routes/device.py:101-104`).
3. **No persistent "add a machine" surface.** Web shows `ConnectHostSection` on
   `/device` and onboarding; mobile shows `install-instructions.tsx` only in
   onboarding. After onboarding, finding the command means remembering the URL.

Smallest changes that make the Nth host trivial (all preserve the ceremony):

- **S — QR code in the terminal.** `spawnd possess`/`login` prints a QR of the
  approval URL *including the `#k=` fragment*. Scanning moves the fragment
  terminal→phone-camera→browser without any HTTP request, so the out-of-band property
  is intact; the phone lands on the existing approve screen. Biggest win for headless
  hosts.
- **S — push the pending pairing.** After the possession proof lands
  (`routes/device.py:162-247`), push to the account's registered phones
  (`PushDevice`, and the knock-push plumbing from `DeviceApprovalRequest` /
  `ws/daemon.py:869-895` already exists as a pattern): "mac-studio wants to join your
  account — approve?", deep-linking the mobile approve screen with `approval_ref`
  (never the user code). Push only after possession-verified, and the push carries no
  authority — the signed approval is unchanged.
- **S — a permanent "Add a machine" entry.** Web: keep `/device`'s
  `ConnectHostSection` reachable from the hosts list at all times; mobile: surface
  `install-instructions` from the hosts tab, not just onboarding. Same commit, both
  frontends.
- **Explicitly not recommended: pre-authorized device codes** ("approve before the
  machine runs anything"). It inverts the possession-before-approval ordering the
  ceremony depends on (`routes/device.py:855-870` requires
  `host_possession_version == 1` before approve) and turns the approval into a bearer
  artifact. Bulk-approval needs are already served by account chains on the device
  axis; the host axis is one click per machine, which is the right floor.

---

## 4. Security summary

SPAWN D's guarantee: the server relays but cannot grant terminal access; admission is
a client-side-verifiable proof — a signed offer from a key the daemon pins, or a chain
of account-scoped endorsements from a ceremony-installed anchor
(`run.rs:1186-1284`, `endorsement_chain.rs`, `docs/TRUST_DEVICE_MESH.md` P2/P5).

- **Option 2 preserves this trivially** — nothing in the trust plane changes.
- **Option 1 can preserve it**, but only with per-account partitioning of anchors,
  chains, and deny-lists, and with membership rows kept inert for terminal admission
  until a per-account out-of-band anchor ceremony completes. It enlarges the trusted
  code surface materially.
- **Option 3 cannot preserve it** without inventing exactly Option 1's cross-account
  ceremony.
- The (b) proposals add no server authority: QR moves the existing fragment
  out-of-band; the push is notification-only, like the `DeviceApprovalRequest` knock
  ("carries no authority", `models.py:477-490`).

---

## 5. Recommendation and incremental path

**Recommendation: Option 2 now; stage Option 1 only if "shared machine, several
humans" becomes a product goal.** The multi-instance machinery is ~80% built and
audited; its gaps are one CLI flag, one script flag, one status listing, and copy.
Option 1 is a Large trust-plane feature whose costs are only justified by team-style
sharing, which also raises unanswered product questions (below).

Ship order:

1. **Now (all S):** `possess --new-account` + hint, install.sh passthrough,
   `spawnd status` instance listing, docs section, web+mobile copy. Plus the (b)
   papercuts: terminal QR, pending-pairing push, persistent Add-a-machine surfaces.
2. **Next (M, only on demand):** `host_members` as a *server-side read grant* behind a
   flag — a member sees host status/metadata and can be shown "ask the owner's device
   to admit yours"; no terminal access implied, clearly labeled. This derisks the
   schema and authorization refactor separately from the trust plane.
3. **Later (L):** per-account trust wire (`registered.accounts[]`), daemon pin-store
   partitioning, and the invite/anchor ceremony that gives a member real terminal
   access. Only after 2 proves the demand.

## 6. Open product questions for Charlie

1. Is (a) about **one human with two accounts** (work/personal) or **two humans, one
   machine**? Option 2 fully solves the first; only the second ever needs Option 1.
2. If hosts become shareable: should members see each other's sessions and the
   `foreground_command` labels (an activity leak between accounts)?
3. Roles for a shared host — who may delete it, trigger daemon updates, revoke
   devices, install agents?
4. Is the two-daemons-per-machine footprint of Option 2 acceptable long-term for the
   multi-account case (double supervision/update churn)?
5. For (b): is a waiting terminal acceptable (recommended), or is there real demand
   for pre-authorized pairing despite its weaker ceremony ordering?
