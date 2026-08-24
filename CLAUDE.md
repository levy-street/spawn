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

## Releasing

Before deploying or releasing anything — server, web, a mobile update or
build, daemon prebuilts — read `docs/RELEASE.md` in full. It is the entire
release process: what ships together, what the deploy script refuses and why,
and how to verify what actually reached production. Its guard rails exist
because skipping one has already caused an outage.
