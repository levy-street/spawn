# P1-05 — API client, auth token store and every typed endpoint

**Phase 1, parallel with eight other agents.** Every screen in the app talks to the server through
you. If an endpoint is missing from your layer, that feature cannot be built.

**Read first:** `00-OVERVIEW.md` (§3 D2 — the auth decision, §5, §7.3, §8), then
`research/03-server-api.md` **in full**. It is a 2,243-line implementation-grade API reference with
the real Pydantic schemas, and its closing "Native API client shape" section is written to be
copied. Then skim `research/02-web-architecture.md §9` for the client-side auth lifecycle.

---

## 1. Objective

Ship `@/data/api`: a fetch client, the auth token store, zod schemas for every wire type, and one
typed function per server route — covering all 79 HTTP routes.

## 2. Files you own

```
src/data/api/client.ts                 # fetch wrapper, ApiError, base URL, auth injection
src/data/api/auth-token.ts             # SecureStore-backed bearer token store
src/data/api/config.ts                 # base URL resolution
src/data/api/schemas/*.ts              # zod schemas grouped by domain
src/data/api/endpoints/*.ts            # typed functions grouped by domain
src/data/api/__tests__/**
```

Suggested domain split for both `schemas/` and `endpoints/`: `auth`, `account`, `devices`, `hosts`,
`sessions`, `workspaces`, `agents`, `skills`, `templates`, `trust`, `legion`, `admin`, `install`,
`capabilities`.

You do **not** own React Query hooks (`src/data/queries/**` belongs to Phase 2 agents per domain),
the query-key registry (`P1-07`), the WebSocket clients (`P1-08`), or SecureStore itself
(`P1-06` owns `src/lib/secure-storage.ts` — import it; if it does not exist yet, code against the
signature in `P1-06`'s plan).

## 3. Specifications

### 3.1 Authentication — read this twice

**The decision is made and verified; implement it exactly.** `research/03 §TL;DR 5` and
`research/12 §TL;DR 3` both claim the native app needs a new server refresh endpoint. **They are
wrong.** The orchestrator verified in the server source:

- `POST /api/auth/login` returns a 15-minute `access_token` in JSON **and** sets a `spawn_session`
  cookie holding a **30-day** token (`server/spawn_server/routes/auth.py:121-122`).
- Both are minted by `_issue_user_token`, which stamps `"kind": "access"` on both
  (`server/spawn_server/auth.py:66-79`).
- `current_user` accepts `Authorization: Bearer …` and only checks `kind == "access"`
  (`server/spawn_server/auth.py:136-145`).

So: on login/signup, read the response's `set-cookie` header, extract the `spawn_session` value,
store it in SecureStore, and send it as `Authorization: Bearer <jwt>` on every subsequent request.
That yields 30-day sessions with **no backend change**. Do not implement a refresh loop, do not
request a server change, do not use the short-lived JSON `access_token` as the stored credential.

`auth-token.ts` implements `00-OVERVIEW.md §7.3` exactly:

```ts
export const authToken: {
  get(): Promise<string | null>;
  set(jwt: string): Promise<void>;
  clear(): Promise<void>;
  captureFromResponse(res: Response): Promise<string | null>;
};
```

`captureFromResponse` must:
- read `res.headers.get('set-cookie')`, tolerate multiple folded cookies in one header value,
  find the `spawn_session=` pair, and stop at the first `;`;
- ignore attribute segments (`Path`, `HttpOnly`, `SameSite`, `Max-Age`, `Secure`) — a naive split
  will happily store `HttpOnly` as your token;
- return `null` (not throw) when the header is absent;
- decode the JWT payload **without verifying** it, purely to read `exp`, and cache the expiry
  alongside the token so the client can detect a hard expiry locally.

Also expose an in-memory cache so every request does not hit SecureStore. Keep the token in memory
after first read; clear it on `clear()`.

### 3.2 `client.ts`

```ts
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: unknown);
}
export function api<T>(path: string, init?: RequestInit & { schema?: ZodType<T> }): Promise<T>;
```

Behaviour:
- Prefixes `path` with the base URL from `config.ts`.
- Injects `Authorization: Bearer <token>` when a token exists. Never sends the header when there
  is none (some routes are deliberately anonymous).
- Sets `Content-Type: application/json` and `Accept: application/json` unless the caller overrides
  (file bodies must be able to opt out).
- Error mapping matches the web client (`web/src/lib/api.ts:44-60`, quoted in `research/03`):
  parse the JSON body, prefer `body.code`, fall back to `http_<status>`, and surface FastAPI's
  bare `{detail: "..."}` string as the human message.
- `204` resolves to `undefined`.
- Validates with the supplied zod schema when present. **On validation failure, throw an
  `ApiError` with code `schema_mismatch` and log the zod issue** — do not silently pass through
  unvalidated data, and do not crash the app.
- Timeouts: wrap every request in an `AbortController` with a default timeout (30s; longer for
  known-slow routes via an option). Mobile networks stall silently — a request with no timeout
  hangs a screen forever.
- Retries: **none by default.** React Query owns retry policy. Do not build a second retry layer.
- On `401`, clear the stored token and emit a single app-level "unauthenticated" event that
  `P2-01`'s auth gate subscribes to. Export a tiny subscribe function for this; do not import
  navigation or React from `client.ts`.

### 3.3 `config.ts`

Base URL resolution, in priority order: an explicit runtime override (set by a settings screen or
dev menu), then `expo-constants` `extra.apiUrl` from `app.json`, then a compiled-in default.
Expose `getBaseUrl()` / `setBaseUrl()`. The owner will point the app at their server, so make this
changeable at runtime and persisted — but keep the mechanism to a few lines.

**UNKNOWN to record, not solve:** the production API origin is the owner's input
(`research/12 §TL;DR 10`). Ship a sensible default, make it overridable, and flag it in your
report.

### 3.4 Schemas and endpoints

From `research/03`'s endpoint catalogue, implement **every** route. For each:
- a zod schema for the response (and the request body where one exists), named for the type
  (`WorkspaceSchema`, `SessionCreateSchema`);
- an exported TS type inferred from the schema;
- an async function named for the operation, taking a typed argument object and returning the
  parsed type.

Rules:
- All wire JSON is `snake_case` (`research/03 §Universal wire conventions`). **Do not camelCase
  it.** Keep wire types wire-shaped; if the app wants friendlier names, that is `P1-07`'s
  selector layer's job. Renaming here creates a translation layer nobody asked for and two names
  for everything.
- Nullable vs optional matters: `field: T | null` (present, nullable) and `field?: T` (may be
  absent) are different, and `research/03` is explicit about which is which. Model both correctly.
- Endpoints the phone cannot use (OAuth redirect flows) still get typed functions, marked with a
  comment explaining the Expo Go limitation (`00-OVERVIEW.md §3 D8`).
- Include the admin and legion routes. They are `P3-02`'s and `P2-06`'s surfaces, but the client
  layer must be complete.

### 3.5 WebSocket URL builders

Export URL builders for `/ws/browser`, `/ws/host` and `/ws/alerts` — including the `?token=`
query parameter, since `research/03 §TL;DR 7` establishes that the query path is the only
guaranteed cross-platform auth for the sockets. `P1-08` consumes these builders; it owns the
socket lifecycle, you own URL construction and auth.

## 4. Rules specific to you

- No React. This layer is framework-free and must be testable in plain Node.
- No navigation, no toasts, no UI concerns.
- Do not build a codegen pipeline, an interceptor stack, or a plugin system.

## 5. Tests

Mock `fetch`; never hit a network.
- `captureFromResponse`: single cookie, multiple folded cookies, attribute-only segments, missing
  header, cookie not first in the list, value containing `=` characters. **This function is the
  linchpin of the auth strategy — test it hard.**
- `api()`: header injection with and without a token; error mapping for a coded body, a FastAPI
  `{detail}` body, and an unparseable body; `204` handling; timeout aborts; schema-mismatch path.
- `401` clears the token and emits the event exactly once.
- A representative sample of endpoint functions (at least one per domain): correct method, path,
  body serialisation, and response parsing.
- Schema round-trip tests using literal JSON fixtures taken from `research/03`'s documented
  response shapes.

## 6. Deliverables checklist

- [ ] `client.ts`, `auth-token.ts`, `config.ts` matching `00-OVERVIEW.md §7.3`
- [ ] Bearer-from-`set-cookie` strategy implemented exactly as specified in §3.1
- [ ] Zod schemas + typed functions for every route in `research/03`'s catalogue
- [ ] WebSocket URL builders exported for `P1-08`
- [ ] Timeouts on every request; no retry layer
- [ ] Tests pass, with the cookie parser exhaustively covered
- [ ] `typecheck`, `lint` clean for your files
- [ ] Progress file current; final report written

## 7. Reporting

Progress: `docs/native/progress/P1-05.md`. Final report: `docs/native/reports/P1-05.md` with a
**complete table of every exported endpoint function** (name, method, path, arg type, return
type) — Phase 2 agents build from that table without reading your source — plus the base-URL
question, anything `research/03` got wrong, `## Requests for other agents`, `## Known gaps`.
