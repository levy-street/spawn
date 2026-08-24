# Working agreements for spawn

Read this before changing anything. `AGENTS.md` is a symlink to this file, so
there is one copy and it cannot drift.

## spawn has two frontends. A change to one is a change to both

`web/` (Next.js) and `mobile/` (Expo/React Native) are two clients of the same
API. They are not a primary and a port — a person signs in on the phone and
picks the session up in the browser an hour later, and anything present in one
place and missing from the other reads as a bug rather than a roadmap.

So any user-facing change ships in both, in the same commit:

- a new screen, control, or flow
- copy, labels, empty states, error messages
- validation rules and what counts as a valid input
- anything read from `/api/auth/config` or another shared endpoint

Both have their own idiom and neither should be a transliteration of the other.
Match the surrounding code — `web/` uses Tailwind and server components,
`mobile/` uses the `@/theme` tokens and the shared `ui/` primitives. Shared
*meaning* stays identical; shared *markup* is not a goal.

When something genuinely belongs to one platform — Face ID unlock, a
`WebAuthn` ceremony that needs a browser — say so in the commit message. An
unexplained one-sided change is indistinguishable from a forgotten one.

Check both before calling a change done:

```bash
cd web    && npm run lint && npx tsc --noEmit
cd mobile && npm run ci        # typecheck + lint + jest
cd server && .venv/bin/ruff check . && .venv/bin/python -m pytest -q
```

## Releasing: the server and the app go out together

Deployment is over SSH, from a coding agent, using the script in this repo.
It refuses to run against a dirty checkout or unpushed commits.

```bash
scripts/deploy-prod.sh <ssh-host>     # pulls, migrates, restarts spawn-server + spawn-web
```

That ships the server and the web app. **It does not touch the phone.** The
installed app keeps running whatever JavaScript it was built with, so a release
that stops there leaves the two frontends on different versions of the same
feature — exactly the split the section above exists to prevent.

Push the matching update in the same release:

```bash
cd mobile && eas update --branch production -m "<same summary as the deploy>"
```

Over-the-air updates carry JavaScript and assets, and they reach installed
builds within a launch or two. They cannot carry native changes. Anything that
alters the native layer needs a real build instead:

- a new dependency with native code, or a config plugin
- entitlements, capabilities, permissions, or `Info.plist` keys
- app icons, the splash screen, the bundle identifier, the display name
- bumping `version` in `app.json` — `runtimeVersion` follows `appVersion`, so a
  version bump orphans every install from further updates until they rebuild

```bash
cd mobile && EXPO_NO_CAPABILITY_SYNC=1 \
  eas build -p ios -e production --non-interactive --auto-submit
```

Credentials live on EAS — distribution certificate, provisioning profile, APNs
key, and the App Store Connect key for submissions — so this needs no Apple
login and runs unattended.

`EXPO_NO_CAPABILITY_SYNC=1` is required until Associated Domains is either used
in the entitlements or removed from the App ID: Apple's API rejects EAS's
attempt to switch it off, and it should stay on for universal links.

## Order of operations

Migrations run before the new server starts, so a release is safe only when the
old code tolerates the new schema. Add columns and backfill in one release,
then start depending on them in the next.

Server config lives in the environment on the production host, not in this repo
and not in EAS. EAS environment variables are build inputs for the app; the
only one this project uses is `EXPO_PUBLIC_API_URL`, already committed in
`eas.json`. A server secret placed in EAS is both ineffective and exposed.
