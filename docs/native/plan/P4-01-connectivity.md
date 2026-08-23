# P4-01 — Server connectivity, in-app server setting, and About routing

**Phase 4 (defect-fix pass), parallel with four other agents.** Phase 3's parity audit
(`docs/native/reports/P3-06-parity.md`) found deterministic defects. You fix the one that blocks
everything else.

**Read first:** `00-OVERVIEW.md` (§5, §7.3, §8), then `docs/native/reports/P3-06-parity.md`
"Top risks" items **2, 4** and rows **F-004, F-005**.

## 1. The problem

> "Neither `expo.extra.apiUrl` nor an in-app server setting is present, so the compiled fallback is
> `http://localhost:8000`. The owner must edit config or have a previously persisted override
> before Login can reach spawn; this is deterministic, not a device-only uncertainty."

A phone cannot reach `localhost:8000`. **As shipped, the owner cannot log in at all.** This is the
single highest-priority fix in the campaign.

Separately, `about-screen.tsx` (install instructions, security explainer) was built but has no
route and is unreachable dead code.

## 2. Files you own

```
mobile/src/data/api/config.ts
mobile/app.json                                  # expo.extra only — change nothing else
mobile/src/components/settings/server-panel.tsx  # new
mobile/src/app/(tabs)/settings/server.tsx        # new
mobile/src/app/(tabs)/settings/about.tsx         # new
mobile/src/app/(tabs)/settings/index.tsx         # add rows only
mobile/src/**/__tests__/**  (yours only)
```

## 3. What to build

### 3.1 An in-app server setting

A Settings → **Server** panel where the owner enters their spawn server URL. It must:

- show the currently effective URL and where it came from (runtime override / `expo.extra` /
  compiled default);
- accept a URL with `P1-03`'s `Input` at `purpose="url"`, normalise it (trim, strip trailing
  slashes, default the scheme to `https://` when omitted), and reject obvious nonsense;
- persist through `config.ts`'s existing `spawn.api.base-url.v1` mechanism — the plumbing already
  exists, you are giving it a UI;
- offer a **"Test connection"** action that hits an unauthenticated endpoint (`/healthz`) and
  reports success/failure with the real error, so the owner can tell "wrong URL" from "server
  down" from "not on the same network";
- warn plainly that changing it signs the current session out, and clear the token when it changes.

### 3.2 Reachable before login

The owner must be able to set the server **without being logged in** — otherwise it is a deadlock.
Add an entry point from the login screen. Keep it minimal: a small "Server" affordance that opens
the same panel. Do not restructure `P2-01`'s login form beyond adding that one control.

### 3.3 A sensible default

Set `expo.extra.apiUrl` in `app.json` to a documented placeholder and make the resolution order
explicit in `config.ts`: runtime override → `expo.extra.apiUrl` → compiled default.

**UNKNOWN — do not guess:** the production API origin is the owner's input. Leave the placeholder
clearly marked and state in your report exactly which one line the owner edits, or that they can
set it in-app instead.

### 3.4 Route the About surfaces

`about-screen.tsx` exists and is unreachable. Add `settings/about.tsx` rendering it and a Settings
row. That closes parity rows F-004 and F-005 without writing new UI.

## 4. Rules
- Do not touch the API client, the auth token store, or any other agent's screens.
- `app.json`: add `expo.extra` only. Changing scheme/bundle id/plugins breaks other agents' work.

## 5. Tests
- URL normalisation: scheme defaulting, trailing slashes, whitespace, invalid input rejected.
- Resolution order: override beats extra beats default.
- Changing the server clears the stored token.
- Test-connection success and failure paths (mock fetch).
- The Settings rows render and route.

## 6. Deliverables
- [ ] Server panel with current-value provenance, validation, persistence, test-connection
- [ ] Reachable from login while signed out
- [ ] `expo.extra.apiUrl` placeholder with documented resolution order
- [ ] About/Security reachable
- [ ] Tests green; typecheck + lint clean for your files
- [ ] Progress `docs/native/progress/P4-01.md`; report `docs/native/reports/P4-01.md` stating
      exactly what the owner must set and where
