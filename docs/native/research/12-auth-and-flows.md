# R12 — Auth, onboarding, settings, hosts, admin and Legion flows

## TL;DR
1. The native gate order is Account → Verify (only when enforced) → Host → Done; live account/host state, not a locally advanced wizard index, selects the screen.
2. Email signup requires a valid email and 8–256 character password; reset requires 12–256; reset links last one hour and verification links two days, are single-use, and a newly issued link supersedes the old one.
3. The current server is browser-session-shaped: login returns a 15-minute bearer plus a 30-day HttpOnly cookie, but exposes no refresh endpoint; a durable native refresh contract is required.
4. Google, Microsoft, and GitHub OAuth currently returns only a browser cookie to a relative web path; it cannot return into the app, and OAuth cannot be tested in Expo Go.
5. A phone cannot host spawnd: it must tell the user to run the installer and spawnd login on a supported Mac/Linux machine, then review and approve the resulting eight-character code.
6. The web settings inventory is exactly Account, Appearance, Notifications, Hosts, Agents, Skills, Templates, Browser devices, and Device trust; Terminal, Sessions, and Security are not settings panels.
7. Host parity includes list/detail, rename, removal, files, sessions, agent availability/install/update, and capacity through Legion; there is no daemon restart, daemon update, or daemon-log UI/API.
8. Device trust depends on Ed25519 device identity and WebAuthn PRF; Ed25519 can be implemented in Expo Go, but WebAuthn PRF cannot, so passkey bundle actions need an explicit unavailable state there.
9. Legion should be in mobile v1 because it is the fleet/capacity surface; Admin can reasonably be deferred because it is operator-only, but doing so is an explicit exception to total parity.
10. Required incoming links include signup invites, verification, reset, device pairing, onboarding, host/files, workspace focus, and session fallbacks; production domain, bundle ID, and URL scheme remain owner inputs.

## 1. Scope and reference model

This report covers every requested non-workspace screen plus the settings/profile surfaces nested in
the app shell. The definitive settings navigation has nine entries:

    Account
    Appearance
    Notifications
    Hosts
    Agents
    Skills
    Templates
    Browser devices
    Device trust

That list and its rendering switch are literal in the reference
(web/src/components/settings/SettingsDialog.tsx:37-51,
web/src/components/settings/SettingsDialog.tsx:106-117). Admin is added only for an admin user
(web/src/components/settings/SettingsDialog.tsx:91-103).

There are no settings components named Terminal, Sessions, Security, or a generic Preferences
panel. Terminal metrics and palettes are fixed configuration
(web/src/components/terminal/xterm-config.mjs:17-26,
web/src/components/terminal/xterm-config.mjs:28-86); Security is a public editorial page
(web/src/app/security/page.tsx:18-27). “Devices” means browser cryptographic identities, not a
generic signed-in-session list.

### 1.1 Shared REST error shape

All web requests send JSON and browser credentials. A non-2xx response becomes an ApiError with
status, code, message and optional detail; FastAPI string detail is promoted to the visible
message (web/src/lib/api.ts:18-65).

    export class ApiError extends Error {
      constructor(
        public status: number,
        public code: string,
        message: string,
        public detail?: unknown,
      )
    }

    api(path, init) -> fetch(API_URL + path, {
      credentials: "include",
      "Content-Type": "application/json",
      Accept: "application/json"
    })

**RECOMMEND:** Preserve this error object in the central mobile API client and render the server's
string detail verbatim where the reference does. It avoids replacing useful errors such as
“host daemon is offline” with generic copy.

### 1.2 Auth configuration

GET /api/auth/config returns enabled providers, whether verification is actually enforced, and
whether email signup is invite-only (web/src/lib/api.ts:428-441,
web/src/lib/api.ts:511-515). Verification is only enforced if configured and the mailer can
actually deliver (server/spawn_server/auth.py:174-198).

    type AuthConfig = {
      providers: Array<{ id: "google" | "microsoft" | "github"; name: string }>;
      email_verification_required: boolean;
      invite_only: boolean;
    };

Every auth and onboarding screen must first support loading, configuration error, and loaded
states. Do not hard-code verification or invite gates.

### 1.3 Validation-copy caveat

The Email/required/minLength attributes on these web forms rely on the browser's localized native
constraint-validation bubble. The repo does not author strings for “required” or malformed email.
For example Login declares type=email and required but only renders API errors
(web/src/app/login/page.tsx:52-92); Signup does the same and adds only the authored hint
“Use at least 8 characters.” (web/src/components/onboarding/signup-form.tsx:55-104).

**UNKNOWN:** Exact iOS-native validation copy is therefore not defined by the reference. Use the
platform's localized form semantics where possible; if product wants app-authored inline copy,
the owner should approve new strings such as “Enter a valid email address” and “This field is
required.” Do not mislabel those as quoted web copy.

### 1.4 Signed-in navigation surfaces

The relevant non-core destinations in signed-in chrome are:

- Archived workspaces;
- Legion fleet strip/page;
- Settings, which opens Account by default;
- Account menu showing email initial/email, then Profile and destructive Log out
  (web/src/components/nav/Sidebar.tsx:531-569,
  web/src/components/nav/Sidebar.tsx:572-620).

The AppShell mounts the global browser-device status banner, confirmation host, toast host,
Settings and Profile on every signed-in route
(web/src/components/nav/AppShell.tsx:205-290). Its current small-screen implementation is a
hamburger plus slide-up navigation drawer and an Add session/New workspace action
(web/src/components/nav/AppShell.tsx:209-253,
web/src/components/nav/AppShell.tsx:269-283). Per the product brief, carry the destinations and
state—not that mobile-web layout—into native navigation.

Archived navigation is hidden when empty, collapsed by default, shows at most five recent rows,
and offers searchable “View all” when longer. Rows open the archived snapshot and expose Restore
and Delete forever (web/src/components/nav/SidebarArchivedSection.tsx:33-77,
web/src/components/nav/SidebarArchivedSection.tsx:128-145,
web/src/components/nav/SidebarArchivedSection.tsx:184-229,
web/src/components/nav/SidebarArchivedSection.tsx:234-325). Delete confirmation is
“Delete {name} forever?”, body “Its layout is discarded. This cannot be undone.”, confirm
“Delete forever” (web/src/components/nav/Sidebar.tsx:323-331).

Implicit per-device chrome state—not Settings controls—uses spawn.sidebar.width (216–420 desktop
pixels), spawn.sidebar.collapsed, spawn.sidebar.archivedOpen,
spawn.sidebar.archivedLastOpened, and spawn.sidebar.legionOpen
(web/src/components/nav/AppShell.tsx:28-33,
web/src/components/nav/AppShell.tsx:88-115,
web/src/components/nav/SidebarArchivedSection.tsx:33-46,
web/src/components/legion/LegionStrip.tsx:26-40). Mobile needs archived/Legion disclosure state,
but should not carry irrelevant desktop width/collapse values.

## 2. Native authentication contract and blocking gaps

### 2.1 Tokens and session lifetime

POST /api/auth/signup, POST /api/auth/login, and successful reset all return:

    {
      "access_token": "<JWT>",
      "user": {
        "id": "<UUID>",
        "email": "person@example.com",
        "created_at": "<ISO timestamp>",
        "email_verified_at": "<ISO timestamp or null>",
        "is_admin": false
      }
    }

The client schema is at web/src/lib/api.ts:392-396 and the server schema at
server/spawn_server/schemas.py:46-61. The bearer lasts 15 minutes by default; the browser session
token lasts 30 days and is set only as an HttpOnly, SameSite=Lax cookie
(server/spawn_server/config.py:26-31, server/spawn_server/auth.py:64-88,
server/spawn_server/auth.py:114-123). Authenticated endpoints accept bearer, cookie, or in some
cases a token query parameter (server/spawn_server/auth.py:135-155).

There is no refresh endpoint in the router inventory
(server/spawn_server/main.py:17-35, server/spawn_server/main.py:80-100). Calling logout only
deletes the cookie; there is no server-side token record to revoke
(server/spawn_server/routes/auth.py:128-134).

**RECOMMEND:** Add a mobile auth exchange that returns a short access token and a rotating,
revocable refresh credential, with refresh and revoke endpoints. Store only the refresh credential
in SecureStore and keep the access token in memory. The current 15-minute bearer alone is not a
usable durable mobile session.

**UNKNOWN:** React Native's cookie jar may retain the existing HttpOnly cookie in a particular
Expo/iOS build, but persistence across app restarts and sharing with an external authentication
browser is not an API contract in this repo. A physical-device spike would resolve it, but it
should not substitute for a documented refresh contract.

### 2.2 Expiry and eviction behavior

Every token carries the user's session_epoch. Password reset increments that epoch, invalidating
all old bearer and cookie tokens (server/spawn_server/routes/account_recovery.py:154-176).
An epoch mismatch returns 401 with exact detail “session ended; sign in again”
(server/spawn_server/auth.py:158-171). Other 401 details include “not authenticated”,
“wrong token kind”, “bad subject”, and “user gone” (server/spawn_server/auth.py:135-155).
The web maps any /api/me 401 to anonymous and protected screens then go to /login
(web/src/lib/auth.ts:12-25, web/src/components/auth/AuthGate.tsx:7-29).

**RECOMMEND:** A single response interceptor should clear native credentials and replace the
navigation stack with Login on any authenticated-request 401. Preserve “session ended; sign in
again” as a one-shot banner on Login.

## 3. Login

### 3.1 Walkthrough

1. Entry: /login, or any protected screen after /api/me returns 401
   (web/src/components/auth/AuthGate.tsx:7-29).
2. Show title “Welcome back” and description “Sign in to reach the shells running across your
   machines.” (web/src/app/login/page.tsx:40-44).
3. Load auth config. Render one provider button per enabled provider. If config fails, show
   “Social sign-in is temporarily unavailable. Email sign-in still works.”
   (web/src/app/login/page.tsx:45-51).
4. Submit POST /api/auth/login with the untrimmed field values
   (web/src/app/login/page.tsx:24-38, web/src/lib/api.ts:480-485). The server normalizes email by
   trim+lowercase and validates password (server/spawn_server/routes/auth.py:104-125).
5. Invalid email/password produces 401 “invalid credentials” without disclosing which was wrong
   (server/spawn_server/routes/auth.py:109-115). Other ApiError messages display directly;
   non-ApiError becomes “Login failed” (web/src/app/login/page.tsx:33-35).
6. Success caches the user, invalidates /me, and replaces the route with /app
   (web/src/app/login/page.tsx:28-32).
7. /app resolves verification, host, and workspace state before routing; it is not necessarily the
   final visible screen (web/src/app/app/page.tsx:17-25, web/src/app/app/page.tsx:67-96).

### 3.2 Fields and controls

| Order | Field/control | Exact specification |
|---|---|---|
| 1 | Provider buttons | “Continue with Google/Microsoft/GitHub”; only configured providers; 44px high; navigates to provider start endpoint. |
| 2 | Email | Label “Email”; no placeholder; email keyboard; autocomplete=email; autofocus; required; disabled during submit. |
| 3 | Password | Label “Password”; no placeholder; secure entry; autocomplete=current-password; required; disabled during submit. |
| 4 | Forgot link | “Forgot password?” → /forgot-password, visually paired with Password label. |
| 5 | Submit | “Sign in”, then “Signing in…”; disabled while submitting; keyboard submit from Password triggers it. |
| 6 | Signup link | “No account? Create one” → /signup. |

These attributes and the DOM/tab order are at web/src/app/login/page.tsx:45-105. Server-side email
format is EmailStr; Login has no password-length constraint
(server/spawn_server/schemas.py:34-43).

## 4. Signup and invitations

### 4.1 Walkthrough

1. Entry: /signup or /signup?invite=CODE; the same account step can appear inside
   /onboarding?invite=CODE (web/src/app/signup/page.tsx:12-17,
   web/src/components/onboarding/onboarding-flow.tsx:341-376).
2. While GET /api/auth/config loads, show “Loading signup”. On failure show “Couldn’t load
   signup”, “The server’s signup settings are unavailable.” and “Try again”
   (web/src/app/signup/page.tsx:18-31, web/src/app/signup/page.tsx:68-75).
3. Show “Create your account” and “Start with an account, then connect the machine where your
   agents work.” An invite query produces “You have an invite — finish creating your account
   below.” (web/src/app/signup/page.tsx:34-47).
4. Render provider buttons, then email/password. Render Invite code only when config.invite_only.
   The URL's invite value pre-fills it (web/src/components/onboarding/signup-form.tsx:17-29,
   web/src/components/onboarding/signup-form.tsx:51-98).
5. Submit POST /api/auth/signup:

       { "email": email, "password": password,
         "invite": invite.trim() === "" ? null : invite.trim() }

   The exact client call is web/src/components/onboarding/signup-form.tsx:31-48.
6. Server trims/lowercases email; requires valid EmailStr; password 8–256; invite at most 256
   (server/spawn_server/schemas.py:34-38, server/spawn_server/routes/auth.py:32-42).
7. Failure copies include “email already in use”, “spawn is invite only right now”, and deliberately
   vague “this invite is not valid” for unknown/used/expired/revoked codes
   (server/spawn_server/routes/auth.py:41-67). Unknown client failures say
   “Could not create your account” (web/src/components/onboarding/signup-form.tsx:44-46).
8. On a closed deployment the very first account needs no invite and becomes admin. Otherwise a
   valid invite is consumed after account creation (server/spawn_server/routes/auth.py:44-85;
   server/spawn_server/invites.py:88-110).
9. Signup best-effort sends verification mail, creates a session, then standalone signup replaces
   to /onboarding; the embedded account step lets derived state advance
   (server/spawn_server/routes/auth.py:87-96, web/src/app/signup/page.tsx:48-53).

### 4.2 Fields and controls

| Order | Field/control | Exact specification |
|---|---|---|
| 1 | Provider buttons | Same provider order returned by config; return_to=/onboarding. |
| 2 | Email | Label “Email”; no placeholder; email keyboard; autocomplete=email; autofocus; required. |
| 3 | Password | Label “Password”; no placeholder; secure; autocomplete=new-password; required; minLength=8; hint “Use at least 8 characters.” |
| 4 | Invite code | Only on invite-only deployment; label “Invite code”; no placeholder; monospaced uppercase styling; autocomplete=off; required. Value is not forced uppercase before API. |
| 5 | Submit | Standalone “Create account”; onboarding “Create account and continue”; busy “Creating account…”. |
| 6 | Login link | “Already have an account? Log in” or embedded “Log in instead”. |

The exact form attributes are at web/src/components/onboarding/signup-form.tsx:55-106.

### 4.3 Invite lifecycle and admin-created links

Invite codes are 24 random bytes encoded URL-safe without padding (32 characters for the generated
form), stored only as SHA-256, single-use, expiring and revocable. The URL is:

    {web_url_or_public_url}/signup?invite={code}

(server/spawn_server/invites.py:20-51). Default expiry is 72 hours
(server/spawn_server/config.py:66-70); Admin may choose 1–720 hours
(server/spawn_server/schemas.py:155-172). The plaintext URL exists only in the create response and
cannot be retrieved later (server/spawn_server/routes/admin.py:43-56).

**Behavioral gap:** OAuth user creation does not call signup_is_open or redeem an invite; when no
matching identity/email exists it creates a user directly
(server/spawn_server/routes/auth_providers.py:314-368). Thus the current “invite-only” gate applies
to email signup, not new OAuth accounts.

**UNKNOWN:** Whether that OAuth bypass is intended policy. The owner/server team must decide before
native OAuth is exposed on closed deployments.

## 5. Provider sign-in

### 5.1 Current web flow

1. Provider buttons are generated from config and navigate to:

       /api/auth/oauth/{google|microsoft|github}/start?return_to=/app
       /api/auth/oauth/{google|microsoft|github}/start?return_to=/onboarding

   (web/src/components/onboarding/oauth-buttons.tsx:4-40).
2. Server creates a hashed, one-use state with a default 10-minute expiry, remembers the current
   user for account linking if signed in, and redirects to the provider
   (server/spawn_server/routes/auth_providers.py:371-404,
   server/spawn_server/config.py:28-31).
3. Google/Microsoft request openid email profile; GitHub requests read:user user:email. Exact
   authorization/token/userinfo endpoints are defined at
   server/spawn_server/routes/auth_providers.py:53-77.
4. Callback errors include “Google sign-in failed: …”, “state and code are required”,
   “invalid auth state”, “auth state was used”, and “auth state expired”
   (server/spawn_server/routes/auth_providers.py:292-310,
   server/spawn_server/routes/auth_providers.py:407-432).
5. A verified provider email is mandatory. Existing provider identity wins, else an explicitly
   linked signed-in user, else matching email account, else a new account
   (server/spawn_server/routes/auth_providers.py:214-289,
   server/spawn_server/routes/auth_providers.py:314-368).
6. Callback sets the 30-day cookie and redirects to remembered return_to
   (server/spawn_server/routes/auth_providers.py:433-442).

return_to accepts only a relative path beginning with one slash, rejects schemes, hosts, //, and
values over 2048 characters (server/spawn_server/routes/auth_providers.py:141-153).

Provider-verified email is stored on AuthIdentity, but new/matched User.email_verified_at is not
updated in this flow (server/spawn_server/routes/auth_providers.py:314-368). On a deployment that
enforces verification, that user is still routed to Verify and must use spawn's emailed link before
pairing a host. The onboarding resend path makes this recoverable, but it is the actual current
behavior—not automatic spawn email verification.

### 5.2 Native/Expo consequence

The existing callback cannot redirect to spawn:// or an HTTPS app link and returns no bearer in
the redirect. Therefore it cannot complete a robust native OAuth session.

**RECOMMEND:** Add a one-time native OAuth transaction: app creates transaction + PKCE verifier;
server callback stores the result and redirects to a registered app/universal link carrying only
an opaque one-use transaction code; app exchanges that code for mobile access/refresh credentials.
Never place a bearer or refresh token in the URL.

**Expo Go conflict:** Expo's official authentication guide says OAuth/OIDC cannot be reliably
tested in Expo Go because the app has no stable custom scheme. expo-web-browser 57.0.2 is included
in Expo Go, but iOS auth-session completion still needs a redirect URI the app owns. Source:
https://docs.expo.dev/guides/authentication/ and
https://docs.expo.dev/versions/latest/sdk/webbrowser/.

**RECOMMEND:** In Expo Go expose email/password auth as the working fallback and label provider
buttons “Available in installed builds” or hide them with explanatory copy. Validate OAuth in an
EAS development build; this is an unavoidable exception to “all features work in Expo Go”.

## 6. Forgot password

### 6.1 Walkthrough

1. Entry: Login → “Forgot password?” → /forgot-password.
2. Initial title “Reset your password”; description “We’ll send a one-time reset link.”
   (web/src/app/forgot-password/page.tsx:30-35).
3. Submit POST /api/auth/password-reset/request with {email}
   (web/src/lib/api.ts:487-492).
4. Both success and every failure go to the identical sent state. The client intentionally ignores
   the error to preserve account-enumeration resistance
   (web/src/app/forgot-password/page.tsx:16-27).
5. Sent state: “Check the inbox associated with that address.” Then:
   “If an account exists for [email], a reset link is on its way. It works once and expires in an
   hour.” and “Your password stays unchanged until you use the link.”
   (web/src/app/forgot-password/page.tsx:37-49).
6. “Back to sign in” returns /login.

| Order | Field/control | Exact specification |
|---|---|---|
| 1 | Email | Label “Email”; no placeholder; email keyboard; autocomplete=email; autofocus; required. |
| 2 | Submit | “Send reset link”; busy “Sending…”; disabled while busy or the raw email is empty. |
| 3 | Back | “Back to sign in” → /login. |

The attributes are at web/src/app/forgot-password/page.tsx:51-77. Server validates EmailStr and
always answers 204 even for nonexistent users or mail failure
(server/spawn_server/schemas.py:118-122,
server/spawn_server/routes/account_recovery.py:119-151).

## 7. Reset password

### 7.1 Walkthrough

1. Email link opens /reset-password?token=TOKEN. Tokens are 32 random bytes encoded as 43
   URL-safe, no-padding characters, stored hashed, and one-use; issuing a newer reset marks
   previous unused tokens used
   (server/spawn_server/routes/account_recovery.py:49-72,
   server/spawn_server/routes/account_recovery.py:133-137).
2. No token: show “This link is missing its token. Request a new one.” and button
   “Request a reset link” → /forgot-password
   (web/src/app/reset-password/page.tsx:45-55).
3. Valid shape: show title “Choose a new password”, description “Use a unique password with at
   least 12 characters.” (web/src/app/reset-password/page.tsx:114-124).
4. Client blocks submission until password length ≥12 and both fields match
   (web/src/app/reset-password/page.tsx:25-30).
5. Submit POST /api/auth/password-reset/confirm with token and new_password
   (web/src/lib/api.ts:493-498). Server constraints are token 16–256, password 12–256
   (server/spawn_server/schemas.py:124-129).
6. Invalid/used/superseded token: “this link is no longer valid”; expired:
   “this link has expired” (server/spawn_server/routes/account_recovery.py:75-96).
7. Success changes password, verifies the email if necessary, invalidates every existing user
   token through session_epoch, returns a fresh session, and replaces to /app
   (server/spawn_server/routes/account_recovery.py:154-176,
   web/src/app/reset-password/page.tsx:33-39).

| Order | Field/control | Exact specification |
|---|---|---|
| 1 | New password | Secure; autocomplete=new-password; autofocus; required; minLength=12; hint “At least 12 characters.” |
| 2 | Confirm new password | Secure; autocomplete=new-password; required; minLength=12. |
| 3 | Error | “Use at least 12 characters.” or “Both passwords must match.”; server error takes precedence. |
| 4 | Notice | “Every device currently signed in to this account will be signed out.” |
| 5 | Submit | “Set new password”; busy “Resetting…”; disabled unless valid and matching. |

These values are at web/src/app/reset-password/page.tsx:58-110.

## 8. Email verification

### 8.1 Link screen

1. Email opens /verify-email?token=TOKEN. The screen POSTs automatically; there is no form
   (web/src/app/verify-email/page.tsx:22-67).
2. Working state: spinner and “Verifying your email…”
   (web/src/app/verify-email/page.tsx:76-83).
3. No token: “This link is missing its token.” (web/src/app/verify-email/page.tsx:43-47).
4. Invalid/used/superseded: “this link is no longer valid”; expired:
   “this link has expired” (server/spawn_server/routes/account_recovery.py:75-96).
5. Failure adds “Verification links work once and expire after two days. Sign in and request a
   fresh one from Settings.” and “Go to sign in”
   (web/src/app/verify-email/page.tsx:121-133).
6. Success updates /me and displays “Your email address is verified.”
   (web/src/app/verify-email/page.tsx:98-106).
7. It loads hosts and reads the per-device skipped-host flag. Continue goes /app only if all
   onboarding gates are satisfied; otherwise /onboarding
   (web/src/app/verify-email/page.tsx:69-96).

The confirm endpoint is public and returns {user}; unlike password reset it does not issue a new
session (server/spawn_server/routes/account_recovery.py:196-206). Therefore a verification link
opened in the native app with no existing login can confirm the address but cannot subsequently
load hosts. The current web success screen assumes its browser already has the signup/login cookie
(web/src/app/verify-email/page.tsx:69-116).

**RECOMMEND:** After native verification success, call /api/me. If authenticated, derive and
continue onboarding; if not, show “Email verified” plus “Sign in to continue”, preserving no token.

Verification token constraints are 16–256; generated links use a 32-byte URL-safe token
(43 characters in the generated no-padding form), are single-use, and expire after two days
(server/spawn_server/schemas.py:131-134,
server/spawn_server/routes/account_recovery.py:33-37,
server/spawn_server/routes/account_recovery.py:99-116).

### 8.2 Unverified callouts and resend

Onboarding shows:

> We sent a link to [email].
>
> Open it in any tab. This page checks every five seconds and will continue automatically.

It polls /api/me every five seconds, automatically advances, and offers “Resend email”
(web/src/components/onboarding/onboarding-flow.tsx:127-143,
web/src/components/onboarding/onboarding-flow.tsx:380-438). Success is
“A fresh verification link is on its way.” A 429 becomes
“You’ve requested several links already. Please wait a while before trying again.”

Account settings instead says “Confirm your email address”, explains that verification keeps
recovery working, and offers “Resend verification email”; success is
“Sent — check your inbox.” (web/src/components/settings/AccountPanel.tsx:18-24,
web/src/components/settings/AccountPanel.tsx:50-73).

The resend cap is five per hour per client; exact generic 429 detail is
“too many requests; slow down” (server/spawn_server/rate_limit.py:90-108,
server/spawn_server/rate_limit.py:121-125).

## 9. Complete onboarding flow

### 9.1 State machine

The step names and rail labels are:

    account -> "Account"
    verify  -> "Verify"
    host    -> "Host"
    done    -> "Done"

(web/src/components/onboarding/step-machine.ts:1-3,
web/src/components/onboarding/auth-shell.tsx:11-16). The current gate is derived:

    if user is null                                      => account
    else if verification required and not verified       => verify
    else if no hosts and host was not skipped             => host
    else                                                   => done

(web/src/components/onboarding/step-machine.ts:18-22). A requested
/onboarding?step=X is honored only when X equals that currently unsatisfied gate; arbitrary
forward/back links cannot bypass gates (web/src/components/onboarding/step-machine.ts:25-35).
When verification is not enforced, Verify is removed from the visible rail
(web/src/components/onboarding/onboarding-flow.tsx:270-276).

The native equivalent must derive from central account/host state on each resume and after each
mutation. Do not persist a wizard page number. The only persisted onboarding value is the
per-device “skip host” flag, key spawn.onboarding.skippedHost
(web/src/components/onboarding/onboarding-flow.tsx:17-18,
web/src/components/onboarding/onboarding-flow.tsx:59-64).

### 9.2 Step-by-step

1. **Load:** fetch /api/me and /api/auth/config. If account load fails, show “Couldn’t load your
   account”, “Check your connection, then try again.”, “Try again”. Config failure uses
   “Couldn’t load sign-in options” with the same recovery
   (web/src/components/onboarding/onboarding-flow.tsx:236-253).
2. **Account:** same Signup form as §4. Embedded title is “Create your account”; description is
   “One account keeps every host and workspace within reach.” An invite callout says
   “Your invite is ready. Create the account it belongs to.” Submit says
   “Create account and continue” (web/src/components/onboarding/onboarding-flow.tsx:26-30,
   web/src/components/onboarding/onboarding-flow.tsx:341-376).
3. **Verify:** title “Check your inbox”; description “Confirm this address before connecting a
   machine.” Show the exact resend/polling state in §8.2
   (web/src/components/onboarding/onboarding-flow.tsx:31-34,
   web/src/components/onboarding/onboarding-flow.tsx:380-438).
4. **Verify transition:** after /me observes verification, hold a 900ms success beat:
   “Email verified. Moving on…” (web/src/components/onboarding/onboarding-flow.tsx:17-18,
   web/src/components/onboarding/onboarding-flow.tsx:293-305).
5. **Host:** title “Connect your first host”; description “Install the daemon on a Mac or Linux
   machine, then approve its pairing code.” Render Install, Pair, Waiting, and “Skip for now”
   (web/src/components/onboarding/onboarding-flow.tsx:35-38,
   web/src/components/onboarding/onboarding-flow.tsx:305-318).
6. **Host discovery:** host list polls every three seconds in the Connect component. The first online
   host triggers a 900ms beat “Your host is online. Building a workspace…”
   (web/src/components/hosts/connect-host.tsx:63-88,
   web/src/components/onboarding/onboarding-flow.tsx:293-297).
7. **Done with online host and no workspace:** POST /api/workspaces with
   {first_session:{host_id:onlineHost.id,cwd:"~"}}. Show “Host connected. Shell summoned.” for
   900ms, then replace to /w/{workspace.id}
   (web/src/components/onboarding/onboarding-flow.tsx:184-214).
8. **Done with an existing workspace, or skipped/no online host:** show “Setup complete.” then
   replace /app. If no online host, heading is “Setup complete” and description
   “Connect a host whenever you’re ready to open your first shell.”
   (web/src/components/onboarding/onboarding-flow.tsx:212-214,
   web/src/components/onboarding/onboarding-flow.tsx:277-283).
9. **Completion failure:** workspace-load error says “Could not check your workspaces.”; create
   error uses server detail or “Could not create your first workspace”; both offer “Try again”
   (web/src/components/onboarding/onboarding-flow.tsx:215-223,
   web/src/components/onboarding/onboarding-flow.tsx:319-335).

### 9.3 What the phone can and cannot do

A physical iPhone cannot run spawnd or install a host. Supported daemon targets are macOS and Linux;
Windows is explicitly unsupported (web/src/app/download/page.tsx:28-60). The reference's browser
OS detection would classify iOS as unknown and say “Install on your machine”, which is inappropriate
native copy (web/src/components/hosts/connect-host.tsx:90-116).

**RECOMMEND:** Native Host step copy:

> On a Mac or Linux machine you control, open Terminal and run:

Then display the deployment-specific command:

    curl -fsSL {server web origin}/install.sh | sh

and the instruction:

> After installation, run spawnd login on that machine.

The command construction and fallback origin https://spawnd.dev are literal
(web/src/lib/platform.ts:19-28, web/src/lib/platform.ts:54-61); the post-install instruction is
at web/src/components/hosts/connect-host.tsx:111-143.
Before the deployment origin is known, the exact rendered fallback command is:

    curl -fsSL https://spawnd.dev/install.sh | sh

The phone **can** copy/share that command, enter the code shown by spawnd login, review host and
phone fingerprints, sign approval with its registered device identity, and wait for the daemon to
appear. It cannot execute the installer, start/restart a daemon service, or prove the desktop host's
private-key possession.

**RECOMMEND:** Add “Copy command”, native Share sheet, and optional “Email instructions to myself”.
The share/copy operation is local and Expo Go-compatible.

## 10. Host pairing/approval ceremony

### 10.1 Daemon side and code shape

spawnd starts POST /api/auth/device/start with its host name, OS, architecture, version, Ed25519
public key and possession proof. Server returns:

    {
      "device_code": "<secret daemon polling credential>",
      "user_code": "QZ4K-7HMT",
      "approval_nonce": "<43-char base64url>",
      "verification_uri": "{public_url}/device",
      "interval": 5,
      "expires_in": 1800
    }

Codes are four characters, hyphen, four characters, using
ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (no 0/O/1/I), expire after 30 minutes, and daemon polling interval
is five seconds (server/spawn_server/routes/device.py:23-49,
server/spawn_server/routes/device.py:88-149).

### 10.2 Phone walkthrough

1. Entry: Onboarding Host, Settings → Hosts → Connect a host, or incoming /device. /device is an
   authenticated AppShell wrapper around the same ConnectHostSection
   (web/src/app/device/page.tsx:1-17).
2. Form field:

   - Label “Code from the terminal”.
   - Placeholder “QZ4K-7HMT”.
   - Text input; autocapitalize characters; autocomplete one-time-code; required.
   - No autofocus in the web reference.
   - Input edits clear any previous review/success.
   - Submit “Look up host”; busy “Checking…”.

   Exact attributes are at web/src/components/hosts/connect-host.tsx:314-345.
3. Submit uppercases and trims, POST /api/auth/device/pending
   (web/src/components/hosts/connect-host.tsx:183-215,
   web/src/lib/api.ts:533-538).
4. Server branches: 404 “unknown user code”; 400 “user code expired”; 400
   “user code is {status}”; 409 “host possession proof is pending”
   (server/spawn_server/routes/device.py:640-667).
5. Client locally derives SHA-256 fingerprint from returned host key and blocks if it differs from
   server-claimed fingerprint. It loads any local pin for the exact key
   (web/src/components/hosts/connect-host.tsx:188-204).
6. Review card says “Check the fingerprint for [host]”, displays the fingerprint, and says
   “Confirm the terminal shows this exact value. If it differs, stop—the connection may be
   intercepted.” (web/src/components/hosts/connect-host.tsx:360-375).
7. Pin branch copy:

   - active: “This exact host key is already active in this browser. Approving again only completes
     the server side.”
   - revoked: “You previously removed this host key. Approving deliberately trusts the same key
     again.”
   - new: “Approval saves this host key in this browser before registering it with the server.”

   (web/src/components/hosts/connect-host.tsx:377-393).
8. Show approving device label when present and its own device fingerprint. Controls are “Back”
   and one of “Fingerprint matches — approve”, “Approve this host again”, or
   “Retry server approval” (web/src/components/hosts/connect-host.tsx:399-438).
9. Approval first persists the exact host pin locally, signs the account+nonce+host-key transcript
   with the device's Ed25519 identity, then POSTs /api/auth/device/approve with all reviewed host
   and device identity fields (web/src/components/hosts/connect-host.tsx:218-265).
10. Server requires verified email when configured and validates unchanged host identity,
    unrevoked device identity, key ownership, proof, and pending state. Relevant exact errors are
    “host identity changed since review; review the device code again”,
    “host key is retained by another account”,
    “browser identity changed or was revoked; review the device code again”,
    “host key is already paired”, and
    “host identity or approval state changed; review the device code again”
    (server/spawn_server/routes/device.py:670-788).
11. Client compares every response identity field against review. Success says
    “[host] is connected. It will appear as soon as its daemon comes online.”, clears the form and
    invalidates hosts (web/src/components/hosts/connect-host.tsx:266-293,
    web/src/components/hosts/connect-host.tsx:354-357).
12. If local pin succeeded but server approval failed, exact recovery text begins
    “The exact host fingerprint is saved locally, but server approval did not complete: …”
    and instructs retry/review while retaining the pin
    (web/src/components/hosts/connect-host.tsx:294-305).

The code does not become a link parameter; the daemon provides the fixed /device URI plus a
separately displayed code. Native may scan/recognize the code, but manual entry remains required
for parity.

## 11. Settings: complete inventory and persistence

### 11.1 Persistence taxonomy

| Scope | Data | Persistence |
|---|---|---|
| Per device | theme | Web localStorage key spawn.theme (web/src/lib/theme-bootstrap.ts:12); native local preferences store. |
| Per device | notification channels/events/muted sessions | Web localStorage key spawn.notify.prefs; native local preferences store. |
| Per device | onboarding host skip | spawn.onboarding.skippedHost. |
| Per device + server registration | Ed25519 private identity and host pins | Private key/pins are local; public device record, endorsements, passkey metadata and opaque trust bundle are server-side. |
| Per account | email, admin flag | users table/API. No email-change UI. |
| Per account | custom agents, yolo preferences, skills, templates | Server database via REST. |
| Per account/host | host name, removal, agent auto-update policy | Server database; daemon performs install/check. |

Theme default is System, with localStorage failure degrading to defaults
(web/src/lib/theme.ts:8-16, web/src/lib/theme.ts:37-46,
web/src/lib/theme.ts:110-119). Notification defaults and bounded muted list are:

    {
      "toast": true,
      "sound": false,
      "system": false,
      "haptics": false,
      "onFinished": true,
      "onAwaiting": true,
      "onDied": true,
      "mutedSessions": []
    }

(web/src/lib/notify-prefs.ts:20-58). Muted sessions are deduplicated and capped at the newest 200
(web/src/lib/notify-prefs.ts:63-82, web/src/lib/notify-prefs.ts:147-153).

### 11.2 Account panel

1. Heading “Account”; read-only “Signed in as {email}”
   (web/src/components/settings/AccountPanel.tsx:43-48).
2. If unverified: the verification callout and resend action from §8.2.
3. “Log out” calls POST /api/auth/logout, closes alert socket, ignores logout failure, and web lands
   on public / rather than Login (web/src/components/settings/AccountPanel.tsx:75-82,
   web/src/lib/auth.ts:56-72). Native should clear local credentials and replace to Login/welcome.
4. “Delete account…” expands an inline destructive form. Copy explicitly states it permanently
   deletes every host pairing, session, workspace, agent, skill, device identity and saved trust;
   daemons keep running but lose this server (web/src/components/settings/AccountPanel.tsx:84-96).
5. Field 1: “Type your email to confirm”; placeholder=current email; autofocus; autocomplete=off.
   Submit remains disabled until trim+case-insensitive match
   (web/src/components/settings/AccountPanel.tsx:98-118,
   web/src/components/settings/AccountPanel.tsx:40-42).
6. Field 2: “Password”; secure; autocomplete=current-password; no placeholder. Hint:
   “Signed up through a provider without a password? Leave this empty.”
   (web/src/components/settings/AccountPanel.tsx:119-131).
7. Controls “Permanently delete”/“Deleting…” and “Cancel”
   (web/src/components/settings/AccountPanel.tsx:138-159).
8. POST /api/account/delete with confirm_email and password only if nonempty
   (web/src/lib/api.ts:693-697). Wrong email:
   “confirmation email does not match this account”; missing/wrong password:
   “password confirmation failed”. Provider-created account can omit password, but supplying a
   wrong one still fails (server/spawn_server/routes/auth.py:142-188).
9. Success deletes host key claims and the user/cascaded owned records, closes daemon sockets
   best-effort, deletes cookie, then logs out (server/spawn_server/routes/auth.py:190-211).

**UNKNOWN:** Native local SecureStore keys/pins cannot be deleted by the server. The deletion
success handler must erase the account-scoped native credential, device private key, host pins,
trust revision floor, preferences, and cached data before navigating away.

### 11.3 Appearance

One three-option radio group (web/src/components/settings/AppearancePanel.tsx:8-17):

| Label | Hint | Value | Default | Scope/effect |
|---|---|---|---|---|
| Light | “Always light” | light | no | Per device; UI and terminal become light. |
| Dark | “Always dark” | dark | no | Per device; UI and terminal become dark. |
| System | “Match this device” | system | yes | Tracks OS appearance live. |

Panel copy: “Applies to this browser. Terminals restyle in place — you do not lose a session by
switching.” When System is selected it says “This device currently prefers {light|dark}.”
(web/src/components/settings/AppearancePanel.tsx:23-33,
web/src/components/settings/AppearancePanel.tsx:70-72).

The reference terminal values are fixed rather than user settings:

    font size: 13
    line height: 1.2
    font family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
      "Liberation Mono", "Courier New", monospace
    scrollback: 100000 lines
    snapshot: 10000 lines
    dark: background #0a0a0a, foreground/cursor #e5e5e5
    light: background #fcfcfc, foreground/cursor #1f1f1f
    light selection: #accef7; inactive #e1e6eb
    Unicode width table: 11

(web/src/components/terminal/xterm-config.mjs:17-36,
web/src/components/terminal/xterm-config.mjs:49-94).

**RECOMMEND:** Do not invent a Terminal settings panel for v1. Apply these constants globally and
let Appearance switch the terminal palette in place.

### 11.4 Notifications

Panel copy says alerts arrive when the host reports them, without polling, and all settings are
per-browser/per-device (web/src/components/settings/NotificationsPanel.tsx:100-108).

**Event toggles — all default on:**

| Label | Exact effect/hint |
|---|---|
| An agent finishes | agent.finished: process exited and shell returned; “crisp, but rarer” because agents often stay running. |
| An agent is waiting for you | agent.awaiting_input: running agent stopped output; finished a turn or awaits permission; same amber state. |
| A session exits or is killed | session.died: shell went away due to crash or host stop. |

Exact copy is at web/src/components/settings/NotificationsPanel.tsx:111-135.

**Channel toggles:**

| Label | Default | Permission/support | Effect |
|---|---:|---|---|
| In-app message | on | none | Toast while looking at app. |
| Sound | off | must arm audio on user gesture | Plays a short cue immediately when enabled. Browser block error: “This browser blocked audio. Try again after clicking the page.” |
| System notification | off | OS notification permission | Only while app/tab is backgrounded. Denied/unavailable has explanatory inline copy. |
| Vibration | off | vibration/haptics available | Short buzz on same enabled events. |

Labels/hints are at web/src/components/settings/NotificationsPanel.tsx:138-196; permission error copy
at web/src/components/settings/NotificationsPanel.tsx:51-95.

The “Alert stream” reports “Connected. Events arrive as they happen.” or
“Not connected — alerts will resume automatically.” “Send a test alert” triggers the enabled local
sound/haptic/toast only (web/src/components/settings/NotificationsPanel.tsx:199-227).
Per-session “Mute alerts” is stored in the same per-device preference; closing every web tab stops
alerts because no background delivery exists (web/src/components/settings/NotificationsPanel.tsx:230-234).

**RECOMMEND:** Use expo-haptics 57.0.1 for native vibration and local tactile responses; it works
in Expo Go. Use expo-notifications 57.0.13 for local/in-app notification behavior. Remote push
notifications do **not** work in Expo Go on Android from SDK 53 and require a development build;
the native app also needs a server push-token/subscription delivery path that does not exist today.
Sources: https://docs.expo.dev/versions/latest/sdk/haptics/ and
https://docs.expo.dev/versions/latest/sdk/notifications/.

**UNKNOWN:** “Total parity” may mean only current foreground alert-stream parity, which works in
Expo Go, or true background push, which is a new server capability and cannot meet the Expo Go
constraint. Owner must select v1 semantics.

### 11.5 Hosts settings summary

Settings → Hosts is the host list plus the complete Connect a host section. It polls every ten
seconds and sorts online hosts first, then by name
(web/src/components/settings/HostsPanel.tsx:23-34).

Each row displays:

- host name; online/offline badge and status dot;
- {os or unknown}/{arch or unknown} · daemon {version or unknown};
- pluralized session count;
- Details → /hosts/{id};
- overflow actions Rename and Remove
  (web/src/components/settings/HostsPanel.tsx:142-215).

Rename is a single autofocus field seeded with the name. Blur or Return trims and saves a nonempty
changed value; Escape cancels (web/src/components/settings/HostsPanel.tsx:128-173).
Remove confirmation is:

> Remove {host.name}?
>
> Its daemon token will be revoked and it will no longer be able to connect.

Confirm label “Remove host” (web/src/components/settings/HostsPanel.tsx:54-61). Empty state is
“No hosts are connected yet.”; load failure starts “Failed to load hosts:”
(web/src/components/settings/HostsPanel.tsx:76-96). Full detail/files behavior is in §13.

### 11.6 Agents

Agents are account-level shortcut definitions that type CLI commands into a session shell
(web/src/components/settings/AgentsPanel.tsx:98-114). The list divides immutable “Built in”
definitions from “Custom agents”; a custom-empty state says
“Add a shortcut for any CLI tool installed on your hosts.”
(web/src/components/settings/AgentsPanel.tsx:133-168).
New-agent defaults are empty name/command/install/yolo arguments, Kind “custom”, and no environment
rows (web/src/components/settings/agent-form.ts:16-29). Yolo defaults false per account
(server/spawn_server/models.py:389-407).

Every row displays agent icon, name, command, “read only” for built-ins, and a yolo switch where the
definition has yolo args/env. The yolo preference is account-level and stored separately from the
definition, including for built-ins (web/src/components/settings/AgentsPanel.tsx:189-253). Its
accessible title is “Run {name} without permission prompts”; definitions without a skip mechanism
disable it and say “{name} has no way to skip its permission prompts”.

Custom row actions:

- Edit.
- Delete; confirmation title “Delete {name}?”, body
  “This removes the shortcut definition. Running sessions are not affected.”, confirm
  “Delete agent” (web/src/components/settings/AgentsPanel.tsx:88-96,
  web/src/components/settings/AgentsPanel.tsx:255-279).

Add/Edit dialog fields in exact order:

| Field | Placeholder | Required/behavior |
|---|---|---|
| Name | “My agent” | Required by submit validation. |
| Kind | “custom” | Required. Free text. |
| Command | “my-agent --interactive” | Required. Hint “A single shell command, including arguments.” |
| Install command (optional) | “npm install -g my-agent” | Optional; used by host install/update. |
| Yolo arguments (optional) | “--dangerously-skip-permissions” | Optional; appended when yolo on. Blank means no toggle unless yolo env exists. |
| Environment | repeated name/value | Name aria-label “Environment variable name”, placeholder KEY; value aria-label “Environment variable value”, placeholder value; Add variable/remove row. |

Exact labels/copy/tab order are at web/src/components/settings/AgentsPanel.tsx:340-469.
Validation is “Name, kind, and command are required.” and
“Environment variable names must be unique.”
(web/src/components/settings/AgentsPanel.tsx:317-330). Footer is Cancel then
“Add agent”/“Save changes”; busy “Saving…” (web/src/components/settings/AgentsPanel.tsx:476-483).
Server limits are Name 128, Kind 64, Command 1024, Install command 2048 and Yolo arguments 256
characters; env/yolo_env are string maps (server/spawn_server/schemas.py:591-611).
Create/update/delete and setPreferences persist to server endpoints
(web/src/lib/api.ts:988-1015).

The exact account-scoped contract is:

    GET    /api/agents
    POST   /api/agents
    PATCH  /api/agents/{agent_id}
    DELETE /api/agents/{agent_id}
    PATCH  /api/agents/{agent_id}/preferences  body { "yolo": boolean }

List returns built-ins plus the caller's custom agents. Definition PATCH/DELETE deliberately return
404 “agent not found” for built-ins, while preferences accept built-ins because the preference row
belongs to the user. The server trims required strings and can return “agent name is required”,
“agent kind is required”, “command is required”, 409 “agent name already exists”, “yolo must be
true or false”, or “agent has no yolo mode”
(server/spawn_server/routes/agents.py:14-36,
server/spawn_server/routes/agents.py:70-109,
server/spawn_server/routes/agents.py:112-203).

### 11.7 Skills

Skills are account-level agent-accessible text objects
(web/src/components/settings/SkillsPanel.tsx:88-93). The edit/create form is inline:

| Order | Field | Control/default/constraints |
|---:|---|---|
| 1 | Name | Text; no placeholder; required by custom trim validation. |
| 2 | Description | Text; no placeholder; optional; trimmed. |
| 3 | Content | Multiline textarea, 8 rows; required by custom trim validation; original untrimmed content is sent. |
| 4 | Grant to new sessions by default | Checkbox; default false. |

The exact form is web/src/components/settings/SkillsPanel.tsx:94-131. Errors are “Name is
required.” and “Content is required.” (web/src/components/settings/SkillsPanel.tsx:65-84).
Server maxima are Name 128, Description 512 and Content 65,535 characters; Description defaults
empty and Grant to new sessions by default defaults false
(server/spawn_server/schemas.py:638-652).
Submit is “Add skill” or “Update skill”; busy text uses three periods “Saving...”; edit mode adds
Cancel (web/src/components/settings/SkillsPanel.tsx:137-147).

Rows display name, optional “default” badge and description. Actions are Edit and Delete.
Deletion uses the platform confirm string “Delete skill {name}?” with no second body
(web/src/components/settings/SkillsPanel.tsx:149-191). Empty/loading:
“Loading skills...” / “No skills yet.” Server endpoints persist list/create/update/delete
(web/src/lib/api.ts:1017-1036).

The exact account-scoped contract is:

    GET    /api/skills
    POST   /api/skills
    PATCH  /api/skills/{skill_id}
    DELETE /api/skills/{skill_id}

The server sorts by name, normalizes the name, trims the description, preserves content, and can
return 409 “skill name already exists” on create or rename
(server/spawn_server/routes/capabilities.py:122-189).

### 11.8 Workspace templates

This panel manages existing server-backed workspace templates; creation is **not** here. A template
is saved from a workspace's overflow menu and used from New workspace
(web/src/components/settings/TemplatesPanel.tsx:27-31,
web/src/components/settings/TemplatesPanel.tsx:84-105).

Every row shows icon, name and summary:

    N tab(s) · N window(s) [· N agent(s)]

(web/src/components/settings/TemplatesPanel.tsx:13-24). Actions:

1. Change icon: opens the shared workspace icon picker and persists icon plus
   icon_source="custom" (web/src/components/settings/TemplatesPanel.tsx:47-55,
   web/src/components/settings/TemplatesPanel.tsx:199-214).
2. Rename: autofocus field, seeded name; maximum sent length 128; empty disables Save; Return saves,
   Escape or Cancel exits (web/src/components/settings/TemplatesPanel.tsx:65-70,
   web/src/components/settings/TemplatesPanel.tsx:109-145).
3. Delete confirmation: “Delete {name}?”, body
   “Workspaces already created from it are not affected.”, confirm “Delete template”
   (web/src/components/settings/TemplatesPanel.tsx:72-80).

The exact account-scoped contract is:

    GET    /api/workspace-templates
    POST   /api/workspace-templates
    PATCH  /api/workspace-templates/{template_id}
    DELETE /api/workspace-templates/{template_id}

Create additionally accepts name, optional host_id/cwd, spec, icon and icon_source. PATCH accepts
the same fields optionally; explicit icon null clears the icon. The server sorts by name and can
return “template name is required” or 404 “template not found”
(web/src/lib/api.ts:949-985,
server/spawn_server/routes/workspace_templates.py:62-150).

### 11.9 Browser devices

The native label should be “Devices” or “App devices”, but preserve the semantics: these rows are
registered Ed25519 identities that hosts authorize, not login sessions. The web heading/copy is:

> Browser devices
>
> Browsers signed in to your account. A new browser needs approval from one that already works
> before hosts will accept it.

(web/src/components/settings/DevicesPanel.tsx:387-395).

Server record:

    type BrowserDevice = {
      id: UUID;
      key_algorithm: "ed25519";
      public_key: string;       // 43-char base64url
      fingerprint: string;      // SHA256: + 16 base64url chars
      label: string | null;     // recognition only, max 64
      created_at: ISODate;
      revoked_at: ISODate | null;
    };

(web/src/lib/api.ts:443-453, server/spawn_server/schemas.py:67-115).

On first authenticated use the app must load or create a local Ed25519 identity, prove private-key
possession to POST /api/browser-devices/register, and reconcile the matching server record. The
screen independently derives fingerprints from public keys; it does not trust the server's
fingerprint label (web/src/components/settings/DevicesPanel.tsx:25-75).
The initial web label is a recognition-only best guess such as “Safari on iPhone”, formed from
browser + platform and capped at 64; it is null when neither can be detected
(web/src/lib/browser-device-registration.ts:98-137). Native should default to the platform device
name or “iPhone”, while still treating only the fingerprint as trusted identity.

Each active row displays:

- label or italic “Unnamed browser”;
- “this browser”/native equivalent on current device;
- “trusted · N host(s)” or “not trusted yet”;
- current device's derived fingerprint;
- “Added {local date}”;
- Rename, Approve… when this trusted device can endorse another untrusted device, and Revoke
(web/src/components/settings/DevicesPanel.tsx:221-370).

“Approve…” expands the device-to-device endorsement ceremony inline:

1. It tells the operator to open Settings → Browser devices on the target and compare the exact
   locally derived fingerprint. Copy warns that the name is only a mutable label and to cancel if
   the fingerprint differs.
2. Controls are “It matches — approve”/“Approving…” and “Cancel”.
3. The current identity must be registered and already trusted by at least one keyed host. The app
   re-derives the target fingerprint and refuses any server/key mismatch.
4. It signs one endorsement for every host that trusts the current device, POSTing them serially.
5. Success says “Approved {label or the device} ({fingerprint}) for N host(s). It can connect
   within a few seconds.”
6. Exact local errors include “This browser has no identity to approve with.”, “This browser is not
   registered with the server.”, and the explanation that a device trusted by no host cannot vouch
   for another.

(web/src/components/trust/device-endorsement.tsx:62-183). The trust map polls every 15 seconds, so
the newly trusted device's badge/callout updates without manual refresh
(web/src/components/trust/device-endorsement.tsx:16-51).

Rename field: autofocus, maxLength 64, placeholder “e.g. Work laptop, Pixel phone”; blank persists
null; controls Save name/Cancel rename; Escape cancels
(web/src/components/settings/DevicesPanel.tsx:232-273,
web/src/components/settings/DevicesPanel.tsx:196-199).

Revoke confirmation:

> Revoke {label or this unnamed browser}?
>
> It immediately loses terminal access on every host. Its key fingerprint is {fingerprint}.

(web/src/components/settings/DevicesPanel.tsx:332-363). The request includes expected_public_key,
preventing a stale row from revoking a replacement key
(web/src/lib/api.ts:607-612). Revoking the current device first disables identity operations, then
cleans local key material. Local cleanup failure is surfaced separately
(web/src/components/settings/DevicesPanel.tsx:82-128).

Registration/edge states and exact controls:

| State | UI |
|---|---|
| Registration failed | “This browser's identity registration failed. Terminal access and approvals are unavailable from here until it succeeds.” + “Retry registration”. |
| cleanup_pending | Server key is revoked but local deletion failed; “Retry local key deletion”. |
| revoked current key | Previous key revoked; “Start fresh on this browser”, which explicitly mints a new untrusted identity. |
| no rows | “No registered browsers.” |
| current device untrusted | “This browser can't open terminals yet”; show fingerprint; tell user to Approve on a working device; offer saved-trust unlock or direct “Connect a host”. |

(web/src/components/settings/DevicesPanel.tsx:396-480).

Revoked devices are collapsed into “Revoked devices (N)”. Clear history confirmation explains that
revocation stays permanent and only tombstones/list entries disappear
(web/src/components/settings/DevicesPanel.tsx:500-529). POST /api/browser-devices/prune returns
{pruned:N} (web/src/lib/api.ts:613-618).

The exact account-scoped REST surface is:

    POST  /api/browser-devices/register
          { key_algorithm:"ed25519", public_key, signature, label? }
    GET   /api/browser-devices
    PATCH /api/browser-devices/{device_id}       { label:string|null }
    POST  /api/browser-devices/{device_id}/revoke
          { expected_public_key:string }
    POST  /api/browser-devices/prune

(web/src/lib/api.ts:577-618). Registration is idempotent for the same active account/key but a
revoked key cannot be re-registered. Revoke immediately pushes recomputed pin sets to connected
hosts best-effort; exact stale-row errors include “browser device changed; refresh before
revoking” and 404 “browser device not found”
(server/spawn_server/routes/browser_devices.py:46-102,
server/spawn_server/routes/browser_devices.py:105-242).

The global failure/revoked banner says identity-dependent connections are disabled while account
recovery/revocation remain available. Its “Open device settings” link points to /settings, but no
/settings page exists—settings is modal state (web/src/components/auth/BrowserDeviceRegistrationStatus.tsx:8-49,
web/src/components/settings/SettingsDialog.tsx:53-60).

**RECOMMEND:** Fix this in native with a real /settings/devices route; do not reproduce the broken
web link.

### 11.10 Device trust

Purpose: carry locally verified host keys to other devices inside a server-stored opaque encrypted
bundle protected by a passkey-derived secret. The server stores ciphertext and passkey IDs; it
cannot read pins (web/src/lib/api.ts:455-469, web/src/lib/api.ts:699-729).

Header summary displays:

- “This browser recognizes N host(s).”
- either “Your saved trust opens with any of N passkey(s).”
- or “No saved trust yet — set up a passkey below so new devices can inherit your hosts
  (N passkeys registered).”

(web/src/components/settings/TrustPanel.tsx:295-333).

Actions and visibility:

| Action | Visible/default | Effect |
|---|---|---|
| Set up a passkey / Set up | Only with no bundle | Create PRF-capable passkey; register metadata; seal all current verified host pins; PUT first bundle. |
| Unlock saved trust here / Unlock | Always | Evaluate one registered passkey's PRF, decrypt bundle, import non-revoked host pins locally. |
| Add a backup passkey / Add backup | Bundle exists | Unlock existing data key, create a second PRF passkey and rewrap the same bundle. |
| Revoke | Passkey rows | Enabled only with exactly two passkeys; unlock survivor, reseal without target, remove metadata. |
| Forget trust on this browser / Forget | Recovery & diagnostics | Delete every local recognized host; connections become unprotected until trusted again. |

Exact titles, descriptions, busy labels and enable conditions are at
web/src/components/settings/TrustPanel.tsx:335-450. The passkey list labels default to “passkey”.
One passkey warns to add a backup before revoke; more than two requires revocation from each
surviving device (web/src/components/settings/TrustPanel.tsx:384-416).

The exact account-scoped server storage/endorsement surface is:

    GET    /api/trust/bundle
    PUT    /api/trust/bundle
           { sealed:string, expected_revision:number|null }
    GET    /api/trust/passkeys
    POST   /api/trust/passkeys
           { credential_id:string, label:string|null }
    DELETE /api/trust/passkeys/{passkey_id}
    GET    /api/trust/hosts/{host_id}/pins
    GET    /api/trust/endorsements?endorsed_device_id={device_id}
    POST   /api/trust/endorsements
           { host_id, endorser_device_id, endorsed_device_id, signature }

(web/src/lib/api.ts:699-772). Bundle PUT is compare-and-set: first creation expects null/0, each
replacement supplies the revision read, and a stale write returns 409 “trust bundle changed since
it was read; re-read and merge before replacing”. Sealed text is capped at 256 KiB, passkeys at 32
per account, and host browser pins at 32 per host
(server/spawn_server/routes/trust_bundle.py:20-27,
server/spawn_server/routes/trust_bundle.py:35-106,
server/spawn_server/routes/trust_bundle.py:110-210,
server/spawn_server/routes/trust_bundle.py:269-389).

Success strings include:

- “Passkey ready. N verified host(s) sealed into your trust bundle.”
- “Imported N host(s) onto this device.” or “Already up to date — …”
- “Backup passkey enrolled. Either passkey now opens your trust bundle.”
- “Passkey revoked. It can no longer open your trust bundle.”
- “Forgot N host(s). This device now connects unprotected until it is trusted again.”

(web/src/components/settings/TrustPanel.tsx:94-140,
web/src/components/settings/TrustPanel.tsx:142-191,
web/src/components/settings/TrustPanel.tsx:198-272).

Passkey failure copy distinguishes unavailable PRF, dismissed prompt, no credential, and unsupported
HTTPS context (web/src/components/settings/TrustPanel.tsx:27-43). Diagnostics display whether
device identity, plain storage, Ed25519 and ECDSA keys persist; failure warns that an identity
minted every load can never be trusted (web/src/components/settings/TrustPanel.tsx:430-474).

#### Expo Go trust boundary

Web trust calls navigator.credentials with the WebAuthn PRF extension
(web/src/components/settings/TrustPanel.tsx:11-25). Expo has no SDK API exposing an equivalent PRF.
Expo's authentication guide points native passkeys to third-party native modules, which are not
part of Expo Go, and ordinary passkey assertion does not by itself expose the same deterministic
PRF secret. Sources:
https://docs.expo.dev/develop/authentication/ and
https://www.w3.org/TR/webauthn-3/#prf-extension.

**RECOMMEND:** In Expo Go, fully support direct host pairing, device registration, local pins and
device-to-device endorsement, but render Set up/Unlock/Add backup/Revoke as unavailable with:
“Saved trust passkeys require an installed build. Approve this device from another trusted device,
or pair a host directly.” This is the only honest fallback.

**RECOMMEND:** For the Expo Go device identity, use the already web-pinned @noble/ed25519 3.1.0
for Ed25519 operations and expo-crypto 57.0.1 for secure 32-byte seed generation and SHA-512. Wire
the library's async SHA-512 hook to expo-crypto and generate the seed explicitly rather than using
a React-Native getRandomValues polyfill. @noble/ed25519 is pure JavaScript; expo-crypto is included
in Expo Go. This also preserves the reference's strict point decoder
(web/package.json:18-22, web/src/lib/signed-signal.ts:1-1,
web/src/lib/signed-signal.ts:140-141). Versions were verified from
https://registry.npmjs.org/%40noble%2Fed25519/latest and
https://registry.npmjs.org/expo-crypto/latest; API/Expo Go support:
https://docs.expo.dev/versions/latest/sdk/crypto/.

**UNKNOWN:** Whether a current third-party React Native passkey module exposes the WebAuthn PRF
extension with byte-for-byte compatible inputs/outputs. Resolve in an EAS development-build spike
before promising installed-build passkey parity.

**RECOMMEND:** Use expo-secure-store 57.0.1 for the account refresh credential and device private
seed. It is included in Expo Go; do not store large sealed bundles there. Face ID-gated
requireAuthentication is not supported in Expo Go, so use ordinary SecureStore there. Source:
https://docs.expo.dev/versions/latest/sdk/securestore/.

**RECOMMEND:** Store nonsecret preferences and public metadata in the centralized app persistence
layer; keep private device key material in SecureStore. A user-visible “Start fresh” action must be
the only path that replaces a revoked identity.

### 11.11 Requested setting categories that do not exist

| Requested category | Actual reference surface |
|---|---|
| Profile | Separate Profile modal (§12), read-only analytics plus Account settings link. |
| Devices | Browser devices panel (§11.9). |
| Trust | Device trust panel (§11.10). |
| Agents | Agents panel (§11.6). |
| Appearance/Theme | Appearance panel (§11.3). |
| Terminal fonts/themes | No user panel; fixed constants in §11.3, theme follows Appearance. |
| Notifications | Notifications panel (§11.4). |
| Security | No settings panel; Account delete and public Security page (§16). |
| Sessions | No signed-in-session management panel. Browser device revocation is the closest security control. |
| Account | Account panel (§11.2). |
| Hosts/Skills/Templates | Real settings panels (§11.5–11.8). |

**RECOMMEND:** Build only real settings initially. If product later adds font choice or session
management, treat that as new product design/API work rather than parity implementation.

## 12. Profile

Profile is a read-only full-mobile modal opened from app navigation, not a URL or settings tab. It
fetches GET /api/profile on open, does not poll, and shows load skeleton/error
(web/src/components/profile/ProfileDialog.tsx:17-64). The response is:

    {
      "id": "...",
      "email": "...",
      "created_at": "...",
      "email_verified_at": "... | null",
      "is_admin": false,
      "totals": {
        "hosts": 0, "hosts_online": 0, "cores": 0,
        "memory_bytes": 0, "sessions_live": 0,
        "sessions_started": 0, "session_seconds": 0,
        "active_days": 0, "current_streak": 0,
        "longest_streak": 0, "peak_hosts_online": 0,
        "peak_sessions": 0, "first_day": null
      },
      "agents": [{"command":"claude","count":1}],
      "days": [{
        "day":"YYYY-MM-DD", "sessions_started":1,
        "session_seconds":100, "peak_sessions":1, "peak_hosts_online":1
      }],
      "hosts": [{
        "id":"...", "name":"...", "os":"...", "status":"online",
        "cpu_cores":8, "memory_bytes":..., "gpu":null,
        "session_count":1, "created_at":"...", "last_seen_at":"..."
      }],
      "history_days": 120,
      "today": "YYYY-MM-DD"
    }

The client contract is web/src/lib/api.ts:108-173. The profile backend uses a 120-day history and
top eight agents (server/spawn_server/legion.py:38-42).

Screen order:

1. Avatar is the uppercase first email character; show email and
   “Possessing machines since {long date}”; append flame and “N day streak” when current streak >0
   (web/src/components/profile/ProfileDialog.tsx:91-110).
2. “Account settings” closes Profile and opens Account settings
   (web/src/components/profile/ProfileDialog.tsx:112-124).
3. “The legion”: hosts online/total, cores if nonzero, memory if reported, live now, sessions
   summoned. “Copy stats” copies a privacy-safe line with only host/core/memory/agent counts and
   “— spawnd”; it contains no hostnames/paths/repos
   (web/src/components/profile/ProfileDialog.tsx:126-147,
   web/src/components/profile/ProfileDialog.tsx:276-315).
4. “Machines”: rows with online/offline dot, name, optional spec
   “N cores · N GB · GPU”, session count. Empty: “No hosts possessed yet.”
   (web/src/components/profile/ProfileDialog.tsx:149-182).
5. “Last {history_days} days”: seven-row activity heatmap; active days and session time; longest
   streak, most hosts at once, most sessions at once
   (web/src/components/profile/ProfileDialog.tsx:184-206,
   web/src/components/profile/ProfileDialog.tsx:241-273).
6. “Agents summoned” when nonempty: command, proportional bar, count, plus privacy explanation that
   only foreground process basename is counted
   (web/src/components/profile/ProfileDialog.tsx:208-236).

**RECOMMEND:** Make Profile a native swipe-to-dismiss sheet/overlay, preserving a vertical scroll
inside the sheet and the read-only data order.

## 13. Hosts

### 13.1 Host API data

GET /api/hosts and GET /api/hosts/{id} return:

    type Host = {
      id: UUID;
      name: string;
      os?: string | null;
      arch?: string | null;
      version?: string | null;
      host_key_algorithm?: "ed25519" | null;
      host_public_key?: string | null;
      host_key_fingerprint?: string | null;
      status: "online" | "offline";
      last_seen_at: ISODate | null;
      session_count: number;
      cpu_cores: number | null;
      cpu_physical_cores: number | null;
      cpu_model: string | null;
      memory_bytes: number | null;
      gpu: string | null;
      cpu_bucket: 0|1|2|3|4|5|null;
      mem_bucket: 0|1|2|3|4|5|null;
      capacity_at: ISODate | null;
    };

(web/src/lib/api.ts:79-106, server/spawn_server/schemas.py:423-448). List/get/rename/remove endpoint
signatures are at web/src/lib/api.ts:541-558; server ownership enforcement is at
server/spawn_server/routes/hosts.py:440-476.

### 13.2 Host detail walkthrough

1. Entry: Settings host Details, Legion row/card, or /hosts/{id}. Screen is authenticated
   (web/src/app/hosts/[id]/page.tsx:49-57).
2. Poll host every 30 seconds and that host's sessions every five seconds
   (web/src/app/hosts/[id]/page.tsx:75-86).
3. Header: Back; server icon; editable name; status badge; Files; overflow actions Rename/Remove
   (web/src/app/hosts/[id]/page.tsx:247-339).
4. Rename: “Host name” autofocus field, seeded current name. Return or blur trims/saves nonempty
   changed name; Escape cancels (web/src/app/hosts/[id]/page.tsx:208-215,
   web/src/app/hosts/[id]/page.tsx:268-296).
   Server maximum is 128 characters (server/spawn_server/schemas.py:520-524).
5. Loading renders skeletons. Failure: “Failed to load host: {error}”
   (web/src/app/hosts/[id]/page.tsx:341-356).
6. Facts:

   | Label | Value |
   |---|---|
   | System | os/arch, each ? if absent |
   | Daemon | version or unknown |
   | Sessions | session_count |
   | Connection | online · heartbeat {relative time/now}, or offline · last seen {relative time/never} |
   | Host identity | ed25519 or legacy unpaired |
   | Fingerprint | fingerprint or not pinned |

   (web/src/app/hosts/[id]/page.tsx:358-374).
7. Agent availability panel (§13.3).
8. Sessions section: count; rows link /sessions/{id} and show agent icon/status, session title,
   agent display name · cwd, and activity detail. Empty:
   “No sessions are running on this host.”
   (web/src/app/hosts/[id]/page.tsx:378-428).
9. Back pops navigation. A cold page with no history goes to Legion
   (web/src/app/hosts/[id]/page.tsx:228-243).

### 13.3 Agent availability on host

Offline host replaces the panel with
“Agent availability is unavailable while the daemon is offline.”
(web/src/components/hosts/HostAgentsPanel.tsx:52-58). Online:

- GET /api/hosts/{id}/agents; manual Refresh.
- Each definition displays name, installed version, “update {latest}” badge, “not installed” badge,
  error/last auto-update error, or path/install/command.
- Auto update checkbox is disabled when no install command.
- Auto update defaults false and persists per account+host+agent
  (server/spawn_server/schemas.py:539-579, server/spawn_server/models.py:414-427).
- Install/Update button is disabled without install command.
- Confirmation: “Install {agent}?” or “Update {agent}?”, body
  “Runs the install command on {host}.”, matching confirm label.
- Result says “{agent}: completed” or “{agent}: failed · {error}” and displays command output.

(web/src/components/hosts/HostAgentsPanel.tsx:63-188). GET agents fails 409
“host daemon is offline” or 504 “host agent check timed out”; install can fail
“agent has no install command”, “host daemon is offline”, or
“host agent install timed out” (server/spawn_server/routes/hosts.py:479-520,
server/spawn_server/routes/hosts.py:565-589). Auto-update policy persists per account+host+agent
(server/spawn_server/routes/hosts.py:592-612).

Important terminology: this “Update” runs an **agent CLI install command**. It does not update
spawnd.

### 13.4 Remove/revoke host

Detail confirmation:

> Remove {host.name}?
>
> Its daemon token will be revoked. Existing session processes on that machine may continue
> locally, but spawn will no longer connect to them.

Confirm is “Remove host” or “Retry deletion” if local trust was already tombstoned
(web/src/app/hosts/[id]/page.tsx:217-225). The client first tombstones the exact local host key and
then DELETEs /api/hosts/{id}; partial failure retains the tombstone and offers retry
(web/src/app/hosts/[id]/page.tsx:99-160).

Server deletion removes pending device codes and browser pins for the host, commits host/token
revocation, then closes a connected daemon with code 4001 “host revoked”
(server/spawn_server/routes/hosts.py:615-667). Success invalidates hosts/sessions, returns to /app,
and reopens Hosts settings (web/src/app/hosts/[id]/page.tsx:143-148).

### 13.5 Host files

/hosts/{id}/files is an authenticated screen with host ID and optional path query:

    /hosts/{hostId}/files
    /hosts/{hostId}/files?path={URL-encoded absolute path}

The wrapper passes initialPath and initialHostId to FileExplorer
(web/src/app/hosts/[id]/files/page.tsx:15-75).

File explorer parity actions:

1. Navigate tree/breadcrumbs, expand/collapse directories, Back/Forward as provided by its internal
   path state.
2. “New folder”: autofocus inline field with aria-label “Folder name”, placeholder “folder name”;
   Return with a nonempty trimmed name creates it, Escape or blur cancels
   (web/src/components/files/FileExplorer.tsx:1376-1411).
3. “Upload”: system file picker, upload selected files to current directory.
4. “Refresh”; “Collapse all”.
5. Row open: directory navigates; previewable file opens Preview.
6. Row actions: Preview, Reveal/Open when host capability permits, Copy path, Copy relative path,
   Download, Rename, Send to host, Delete
   (web/src/components/files/FileExplorer.tsx:891-960).
7. Rename uses an autofocus inline field with aria-label “Rename entry”, no placeholder; Return
   saves a changed nonempty trimmed name, Escape/blur cancels
   (web/src/components/files/FileExplorer.tsx:1215-1237).
8. Delete confirmation:

       Delete {name}{ and everything in it when directory}?

   then calls file delete (web/src/components/files/FileExplorer.tsx:563-747).
9. “Send to host” chooses destination host/path and invokes host-to-host transfer.
10. Preview supports previous/next file, image fit control, reveal/open external when supported,
    download and copy path. Files over 4 MiB ask before loading full preview.

Header/new-folder action rendering is at web/src/components/files/FileExplorer.tsx:969-1046 and
web/src/components/files/FileExplorer.tsx:1376-1411. All file operations are direct
browser/mobile-to-daemon control/data behavior, not the FastAPI hosts REST router.

**RECOMMEND:** Use native document picker/share/download APIs but preserve the same operations and
confirmation semantics. This is a substantial sub-feature, not a simple host metadata screen.

### 13.6 Actions requested in the brief that do not exist

| Requested action/data | Reference reality |
|---|---|
| Rename | Exists. |
| Revoke/remove | Exists and revokes daemon authority. |
| Restart daemon | No web UI and no server endpoint. |
| Update daemon | No web UI and no server endpoint. Agent CLI update is different. |
| View daemon logs | No web UI and no server endpoint. Agent install output is not daemon logs. |
| Capacity | Exists in Legion/sidebar through heartbeat buckets and optional direct live channel, not host detail facts. |
| Files | Exists as full FileExplorer screen. |
| Diagnostic ping | POST /api/hosts/{id}/control/ping exists server-side but has no web API helper or UI; it returns 204, offline 409, timeout 504 (server/spawn_server/routes/hosts.py:549-562). |

**RECOMMEND:** Do not invent restart/update/logs in parity v1. If the owner wants them, the daemon
protocol and authorization UX must be designed first.

## 14. Legion

### 14.1 Meaning and access

“The legion” is the authenticated fleet/capacity overview: every owned machine, coarse or direct
live capacity, and session attention. It is available to every authenticated user, not admins only
(web/src/app/legion/page.tsx:16-34).

### 14.2 Full page

1. GET hosts every 15 seconds and sessions every five seconds; derive all rows/totals client-side
   (web/src/app/legion/page.tsx:36-47).
2. Heading “The legion”; loading “Counting your machines…” else a summary line
   (web/src/app/legion/page.tsx:55-60).
3. “Go live” toggle becomes “Live”. Off by default. On opens direct per-host capacity channels only
   while page/cards are mounted; it does not persist
   (web/src/app/legion/page.tsx:16-24, web/src/app/legion/page.tsx:62-75).
4. Totals: hosts online/total, cores if >0, memory if available, live sessions, need you
   (web/src/app/legion/page.tsx:78-87).
5. Live privacy callout:
   “Live figures come straight from each daemon over its direct channel. They never pass through
   the spawnd server, which only ever sees a five-level reading on the thirty-second heartbeat.”
   (web/src/app/legion/page.tsx:89-98).
6. Empty: “No hosts possessed yet.” and “Possess a machine” opens Hosts settings. Nonempty adds a
   dashed “Possess another machine” card (web/src/app/legion/page.tsx:100-138).

Each host card displays:

- status dot, name linking host detail, online OS/offline;
- optional spec line cores · memory · GPU;
- CPU/MEM bucket bars while online; label is Idle, Light, Working, Busy, Heavy, or Pinned;
- when live, exact integer percentages plus optional load one-minute and uptime;
- live session count, need-you count, running agent summary;
- “This host does not report live capacity.” when direct telemetry is unavailable
  (web/src/components/legion/LegionHostCard.tsx:26-124,
  web/src/lib/legion.ts:285-317).

The compact sidebar strip is hidden with no hosts, shows up to four hosts, supports collapse with
per-device key spawn.sidebar.legionOpen, and links its rail/+N more to /legion
(web/src/components/legion/LegionStrip.tsx:26-299). Desktop hover detail shows spec, CPU/MEM buckets
and up to six session rows, but is read-only (web/src/components/legion/LegionHostDetail.tsx:8-35,
web/src/components/legion/LegionHostDetail.tsx:37-98).

**RECOMMEND:** Include Legion in mobile v1. It is not an admin novelty; it is the only complete
capacity/fleet surface. Replace hover detail with a tap/long-press native popover or simply route
to the full Legion/host detail screen.

## 15. Admin

### 15.1 Meaning, authorization, and scope recommendation

Admin is deployment operation, not personal settings: invitations, all users, mail delivery status,
and redacted outbound email logs. The UI checks user.is_admin; non-admins see:

> Nothing here
>
> This account does not administer this deployment.
>
> Back to spawn

(web/src/app/admin/layout.tsx:23-48). Every /api/admin endpoint independently checks is_admin and
returns 404 “not found” to non-admins (server/spawn_server/routes/admin.py:27-40).

Web can serve admin on admin.{domain}; middleware rewrites that hostname to /admin and notes that
the separate origin has a separate cookie jar. This is packaging, never authorization
(web/src/middleware.ts:3-13, web/src/middleware.ts:14-45). Native needs no separate origin; call the
same guarded API origin.

**RECOMMEND:** Admin may be out of scope for mobile v1 because it is privileged deployment
maintenance, dense tables are poorly suited to the primary phone workflow, and excluding it
reduces exposure of all-user/mail data. However, this is explicitly an exception to the owner's
“total feature parity”; the owner must approve the exception. The simplest parity implementation
is three native list sections with no new capabilities.

### 15.2 Admin chrome

Header displays spawn, admin badge, current email, and “Exit admin”
(web/src/app/admin/layout.tsx:50-69). Page section order is Invites, Users, Email
(web/src/app/admin/page.tsx:23-30).

### 15.3 Invites

Heading “Invites”; copy:

> Signup is closed: an invite admits exactly one account, once, before it expires.

(web/src/app/admin/page.tsx:300-307).

Form fields:

| Order | Field | Exact specification |
|---:|---|---|
| 1 | Email (optional) | type=email; placeholder “send it for me”; blank sends null. |
| 2 | Expires in (hours) | numeric; default “72”; min 1; max 720. |
| 3 | Submit | “Create invite”; busy “Creating…”. |

(web/src/app/admin/page.tsx:250-267, web/src/app/admin/page.tsx:309-338). Server validates EmailStr
and 1–720 (server/spawn_server/schemas.py:155-160). POST /api/admin/invites persists the invite,
best-effort emails it if an email was supplied, but still returns the live URL when email delivery
fails (server/spawn_server/routes/admin.py:118-146).

Fresh state:

- “Invite ready” or “Invite ready — emailed to {email}”.
- code URL; “Copy link”/“Copied”; “Dismiss”.
- “Copy it now — the code is stored hashed, so this link cannot be shown again. Expires {date}.”

(web/src/app/admin/page.tsx:346-370). List columns: For, State, Created, Expires, action. For is the
email or “anyone with the link”; state is pending/used/expired/revoked; pending alone shows Revoke.
Empty “No invites yet.” (web/src/app/admin/page.tsx:373-428).
Revoke is immediate with no confirmation in the reference
(web/src/app/admin/page.tsx:279-282, web/src/app/admin/page.tsx:411-421).

### 15.4 Users

Read-only list caption “Every account on this deployment. N total.” Columns:

- Email plus admin badge and UUID;
- Joined local timestamp;
- Verified timestamp or warning “unverified”;
- Hosts count;
- Sessions count;
- Devices count.

(web/src/app/admin/page.tsx:181-247). API output fields are defined at
web/src/lib/api.ts:621-631; counts use owned hosts, all sessions, and nonrevoked browser devices
(server/spawn_server/routes/admin.py:59-104). There is no promote/demote, suspend, delete, inspect,
impersonate, or reset action in the UI/API.

### 15.5 Email

Heading “Email”; explanation that every attempted message is logged and reset/invite credentials
are stripped (web/src/app/admin/page.tsx:39-70).

Mail status states:

- loading “Checking mail configuration…”
- “Delivering via {smtp_host} as {from_address}”
- “Not delivering — backend is {backend}. Password resets and invitations are recorded but never
  sent. Set SPAWN_SMTP_HOST to turn delivery on.”
- “Send test email”/“Sending…”, always sent to current admin because UI passes null
  (web/src/app/admin/page.tsx:72-114).

Test success: “Sent to {to}.”; nondelivery:
“Not delivered: {error or unknown reason}”; unknown client error
“Could not send a test email” (web/src/app/admin/page.tsx:46-58).

Log columns: When, To, Subject, Kind, Status. Status is sent/failed/not delivered. Tap row expands
transport error and redacted body, falling back “(body not recorded)”. Empty:
“No email sent yet.” (web/src/app/admin/page.tsx:116-178). GET defaults to newest 100 and clamps
1–500 (server/spawn_server/routes/admin.py:177-204).

The complete API surface is:

    GET  /api/admin/mail
    GET  /api/admin/emails
    POST /api/admin/emails/test       {"to": null}
    GET  /api/admin/users
    GET  /api/admin/invites
    POST /api/admin/invites           {"email": string|null, "ttl_hours": number|null}
    POST /api/admin/invites/{id}/revoke

(web/src/lib/api.ts:668-687).

## 16. Public Download and Security screens

### 16.1 Download

/download is a public marketing/install page, not authenticated settings. Its actionable surface:

1. Detect browser OS as macOS/Linux/Windows/unknown.
2. macOS: installer downloads Darwin Apple Silicon/Intel build and starts LaunchAgent
   app.spawn.spawnd.
3. Linux: downloads x86_64/arm64 build and starts user systemd spawnd.service when available.
4. Windows: “Use a macOS or Linux host”; Windows build/service unavailable.
5. Unknown: installer supports macOS/Linux and detects the actual target when run
   (web/src/app/download/page.tsx:19-76).
6. Display deployment install command; “Copy command”; “Create account”
   (web/src/app/download/page.tsx:182-218).
7. Explain macOS, Linux and remote hosts/SSH.
8. Show prebuilt-only smoke-test command:

       curl -fsSL {origin}/install.sh | sh -s -- --prebuilt-only

   (web/src/app/download/page.tsx:256-280, web/src/lib/platform.ts:26-28).

**RECOMMEND:** In native, fold the actionable Download content into Onboarding/Hosts and optionally
retain an About → Install a host static screen. Do not show an iPhone as a supported daemon target.

### 16.2 Security

/security is a public, static editorial page with no form or API. Its core claims/surfaces:

- Title “Security — the server that can't read your terminal”.
- Hero “We introduce. We never listen.”
- Explains endpoint-only WebRTC terminal encryption, control-plane signaling only, encrypted TURN
  relay fallback, visible host/device fingerprints, explicit pairing/revocation, and the threat
  model's server-as-adversary stance.
- CTAs Sign up and Install the daemon
  (web/src/app/security/page.tsx:18-75,
  web/src/app/security/page.tsx:77-112,
  web/src/app/security/page.tsx:244-280).

**RECOMMEND:** Treat as a native static About/Security screen or open the canonical HTTPS page.
It is not a Security settings panel and has no persistence.

## 17. Account and fleet edge-state matrix

| Edge state | Detection | Exact current UI/branch | Native action |
|---|---|---|---|
| Signed out | /api/me 401 | Protected page loading then /login (web/src/components/auth/AuthGate.tsx:7-29). | Clear stack to Login. |
| Auth lookup network error | /api/me non-401 failure | /app: “Could not check your account” + detail (web/src/app/app/page.tsx:110-117); onboarding retry state in §9. | Retry, do not misclassify as signed out. |
| Expired/invalid bearer | authenticated request 401 | Becomes anonymous; exact server error may be “invalid token: …” (server/spawn_server/auth.py:103-111). | Clear credential; Login banner. |
| Password reset evicted session | epoch mismatch | 401 “session ended; sign in again” (server/spawn_server/auth.py:158-171). | Clear credential; show that message. |
| Account deleted elsewhere | token resolves no user | 401 “user gone” (server/spawn_server/auth.py:150-155). | Clear all account-scoped local data; Login. |
| Unverified email, enforcement on | config true + email_verified_at null | /app redirects /onboarding; host approve returns “verify your email address before pairing a host” (web/src/app/app/page.tsx:57-85, server/spawn_server/auth.py:187-198). | Verification gate + resend. |
| Unverified email, mailer/enforcement off | config false | Verify rail omitted and pairing allowed (web/src/components/onboarding/onboarding-flow.tsx:270-276). | Do not invent a gate. Account may still show unverified callout. |
| Verification link missing | no token | “This link is missing its token.” (web/src/app/verify-email/page.tsx:43-47). | Sign-in action. |
| Verification link succeeds while signed out | confirm is public but returns no session (server/spawn_server/routes/account_recovery.py:196-206). | Web can stall checking hosts because its success screen assumes an existing cookie (web/src/app/verify-email/page.tsx:69-116). | Show verified success, then Sign in to continue. |
| Verification/reset link used/superseded | used/missing hash | “this link is no longer valid” (server/spawn_server/routes/account_recovery.py:75-96). | Fresh-request path. |
| Verification/reset link expired | expires_at ≤ now | “this link has expired” (server/spawn_server/routes/account_recovery.py:87-94). | Fresh-request path. |
| Signup closed/no invite | invite-only and not first | 403 “spawn is invite only right now” (server/spawn_server/routes/auth.py:52-57). | Keep form + visible error. |
| Bad invite | unknown/used/expired/revoked | 403 “this invite is not valid” (server/spawn_server/routes/auth.py:58-67). | Keep form; no state disclosure. |
| Auth rate limit | caps exceeded | 429 “too many requests; slow down”, Retry-After header (server/spawn_server/rate_limit.py:90-108). | Disable/retry countdown from header when available. |
| No hosts, not skipped | host list empty | /app redirects /onboarding?step=host (web/src/app/app/page.tsx:79-85). | Host onboarding. |
| No hosts, skipped | local skipped flag true | “Connect a host to start a session” / “Install the daemon…” / “Connect a host” (web/src/app/app/page.tsx:152-163). | Empty fleet state; reopen Host flow. |
| Hosts exist, no workspace, all offline | no firstOnlineHost | “Your host is offline” / “Bring a daemon online before creating the first workspace.” / “View hosts” (web/src/app/app/page.tsx:166-177). | Host list, retry/poll. |
| Online host, no workspace | no workspace | “Create your first workspace” / folder prompt / “New workspace” (web/src/app/app/page.tsx:180-211). | Workspace creation flow. |
| Host offline detail | host.status offline | Connection “offline · last seen …”; agent panel unavailable; sessions may remain listed (web/src/app/hosts/[id]/page.tsx:358-396, web/src/components/hosts/HostAgentsPanel.tsx:52-58). | Disable daemon-dependent actions. |
| Host disappears/not owned | GET host error | “Failed to load host: …” (web/src/app/hosts/[id]/page.tsx:346-350). | Back + retry; 404-safe empty. |
| Pair code unknown/expired/not ready | pending endpoint | Exact errors in §10. | Preserve entry and allow recheck. |
| Device registration failed | registration query error | Global banner + Devices retry; terminals/approvals disabled (web/src/components/auth/BrowserDeviceRegistrationStatus.tsx:14-30). | Non-dismissable security banner. |
| Device revoked | server row revoked/local state | Explicit “Start fresh”; replacement starts untrusted (web/src/components/settings/DevicesPanel.tsx:407-432). | Never silently replace identity. |
| Device untrusted | no trusted host pins | “This browser can't open terminals yet” with fingerprint and approval/direct pairing paths (web/src/components/settings/DevicesPanel.tsx:448-481). | Block terminal handshake; endorsement/pairing CTA. |
| Trust storage unavailable | key/identity probe fails | Diagnostics warn identity will re-mint and signed connections cannot work (web/src/components/settings/TrustPanel.tsx:451-471). | Fatal trust-storage explanation; do not connect unpinned accidentally. |
| Passkey lacks PRF | PRF flag false | “This passkey cannot derive a trust secret…” (web/src/components/settings/TrustPanel.tsx:27-39). | Endorsement/direct-pair fallback. |
| Admin route nonadmin | is_admin false | “Nothing here…”; API 404 (web/src/app/admin/layout.tsx:34-47, server/spawn_server/routes/admin.py:35-40). | Hide nav; safe route guard. |
| Mail not delivering | mailer_ready false | Admin “Not delivering…”; verification enforcement itself becomes false (web/src/app/admin/page.tsx:78-99, server/spawn_server/auth.py:187-198). | Admin warning; no impossible verification gate. |

### 17.1 Subscription/quota states

There is no billing, subscription, plan, entitlement, payment or quota router in the server app's
complete router registration (server/spawn_server/main.py:17-35,
server/spawn_server/main.py:80-100), and no such settings panel
(web/src/components/settings/SettingsDialog.tsx:37-51). The limits encountered here are technical
validation/rate/trust limits, not commercial plans.

**RECOMMEND:** Do not create subscription/quota UI for parity v1.

## 18. Deep links and universal links

### 18.1 Required route table

| Incoming shape | Source and semantics | Native handling |
|---|---|---|
| /signup?invite={token_urlsafe_24_bytes} | Admin invite URL (server/spawn_server/invites.py:20-30). | Open Signup/Onboarding Account with invite prefilled; do not log/store full URL. |
| /verify-email?token={token_urlsafe_32_bytes} | Verification email (server/spawn_server/routes/account_recovery.py:99-104). | POST confirm once; then derive onboarding destination. |
| /reset-password?token={token_urlsafe_32_bytes} | Reset email (server/spawn_server/routes/account_recovery.py:133-137). | Open Reset form; token stays in memory. |
| /device | verification_uri from daemon; code is separate (server/spawn_server/routes/device.py:141-149). | Require auth, then pairing entry. |
| /onboarding | Signup/provider return and explicit entry. | Derive gate from server/local state. |
| /onboarding?step=account\|verify\|host\|done | Requested gate (web/src/components/onboarding/step-machine.ts:25-35). | Honor only if it equals derived gate. |
| /login | Auth entry. | Login. |
| /forgot-password | Recovery entry. | Forgot form. |
| /app | Post-auth resolver (web/src/app/app/page.tsx:17-25). | Native resolver, then replace destination. |
| /hosts/{UUID} | Settings/Legion host detail (web/src/app/hosts/[id]/page.tsx:59-86). | Auth-gated Host detail overlay/page. |
| /hosts/{UUID}/files?path={encoded path} | Host file explorer (web/src/app/hosts/[id]/files/page.tsx:15-75). | Auth-gated Files; pass decoded initial path after validation. |
| /legion | Fleet page. | Auth-gated Legion. |
| /admin | Deployment admin. | Auth + admin guard. |
| /w/{workspaceId}?tab={tabId}&focus={sessionId} | Notification target when workspace/tab contains session (web/src/hooks/useSessionAlerts.tsx:191-199). | Open workspace, select tab, open/focus terminal overlay. |
| /sessions/{sessionId} | Notification fallback or Host session row (web/src/hooks/useSessionAlerts.tsx:191-199, web/src/app/hosts/[id]/page.tsx:399-424). | Open standalone terminal overlay/session screen. |
| /download | Public install instructions. | Native install-help screen or canonical web page. |
| /security | Public security editorial. | Native static screen or canonical web page. |

Profile and Settings have no current URLs; they are module-store modals
(web/src/components/profile/ProfileDialog.tsx:34-47,
web/src/components/settings/SettingsDialog.tsx:53-60). Native should give them canonical internal
routes such as /profile and /settings/{section}; accepting those incoming links would be a
compatible extension. /settings in the current web banner is a broken reference, not an actual
route (§11.9).

### 18.2 Sensitive-link rules

- Verification/reset/invite tokens are bearer credentials. Redact query strings from analytics,
  crash breadcrumbs, clipboard previews, screenshots, and logs.
- Consume verification only once per app process even if React/navigation remounts; the web caches
  one promise per token to prevent duplicate POSTs
  (web/src/app/verify-email/page.tsx:14-28).
- Reset/verify screens must support both a cold app launch and already-running app.
- If not signed in, /device should preserve only the intent to open pairing after Login. Pairing
  still needs a code.
- Workspace/session/host links must retain the target across Login but verify ownership after auth.
- Unknown or malformed UUID/path/token must show a recoverable error, never fall through to an
  unrelated account's cached screen.

### 18.3 Expo linking configuration

Versions below were verified from each package's npm latest dist-tag on 2026-08-22; Expo Go
compatibility was checked against the official Expo “latest” SDK pages:

| Package | Verified version | Why here | Expo Go |
|---|---:|---|---|
| expo-router | 57.0.15 | File-based native route/deep-link mapping and overlay stacks. | Yes. |
| expo-linking | 57.0.7 | Parse incoming HTTPS/custom-scheme URLs and open canonical web fallbacks. | Yes for ordinary links; generic Expo Go does not own the production scheme/universal-link entitlement. |
| expo-web-browser | 57.0.2 | Installed-build OAuth auth session. | Module runs, but a stable OAuth redirect into this app cannot be validated in generic Expo Go. |
| expo-secure-store | 57.0.1 | Small native credentials/private device seed. | Yes; iOS Face ID-gated requireAuthentication is unavailable in Expo Go. |
| expo-crypto | 57.0.1 | Secure random seed and SHA-512 for the pure-JS Ed25519 implementation. | Yes. |
| expo-haptics | 57.0.1 | Pairing/approval, destructive confirmation, sheet and alert tactile feedback. | Yes. |
| expo-notifications | 57.0.13 | Local notification permission/presentation. | Local/foreground behavior yes; remote push needs a development build and new backend delivery. |

The authoritative package pages are
https://docs.expo.dev/versions/latest/sdk/router/,
https://docs.expo.dev/versions/latest/sdk/linking/,
https://docs.expo.dev/versions/latest/sdk/webbrowser/,
https://docs.expo.dev/versions/latest/sdk/securestore/,
https://docs.expo.dev/versions/latest/sdk/crypto/,
https://docs.expo.dev/versions/latest/sdk/haptics/, and
https://docs.expo.dev/versions/latest/sdk/notifications/.
Registry version sources are https://registry.npmjs.org/expo-router/latest,
https://registry.npmjs.org/expo-linking/latest,
https://registry.npmjs.org/expo-web-browser/latest,
https://registry.npmjs.org/expo-secure-store/latest,
https://registry.npmjs.org/expo-crypto/latest,
https://registry.npmjs.org/expo-haptics/latest, and
https://registry.npmjs.org/expo-notifications/latest.

**RECOMMEND:** Use expo-router 57.0.15 and expo-linking 57.0.7; both are included in Expo Go and
support route parsing/openURL. Configure a custom scheme such as spawn plus HTTPS universal links
for the production web domain. Sources:
https://docs.expo.dev/versions/latest/sdk/router/ and
https://docs.expo.dev/versions/latest/sdk/linking/.

iOS universal links require an apple-app-site-association file on the HTTPS domain and the
code-signed com.apple.developer.associated-domains entitlement; that behavior cannot be genuinely
tested inside generic Expo Go. It requires an EAS development/production build. Source:
https://docs.expo.dev/linking/ios-universal-links/.

**UNKNOWN:** Production web domain(s), app scheme, iOS bundle identifier, Apple Team ID, Android
package name and signing fingerprints are not fixed by the inspected repo. Those values are needed
to write the final scheme, AASA and assetlinks.json.

**RECOMMEND:** HTTPS links remain canonical in emails so they work before installation. The web
page should offer Open in app through universal linking and remain a full fallback.

## 19. Screen-by-screen native build checklist

### 19.1 Shared infrastructure

- [ ] Central AuthStore: auth config, user, loading/error, access/refresh state, login/signup/logout,
  401 eviction and secure wipe.
- [ ] Central DataStore/query layer: hosts, sessions, workspaces, agents, skills, templates,
  browser devices, trust bundle, profile, admin; stable query keys and derived selectors.
- [ ] ApiClient matching ApiError semantics and exact endpoint request/response shapes.
- [ ] Account-scoped cleanup function for logout, account deletion and account switch.
- [ ] DevicePrefs: theme, notification preferences/muted sessions, onboarding host skip.
- [ ] DeviceIdentityService: SecureStore private seed, Ed25519 signing, public registration,
  fingerprint derivation, revoked/cleanup states.
- [ ] HostPinStore: account+server-origin scoped active/revoked pins, exact Host-ID/key bindings,
  safe tombstones and import/endorsement flows.
- [ ] LinkRouter: sensitive query redaction, deferred post-login intent, route validation.
- [ ] Global components: Screen, NativeSheet/SwipeDismissPage, FormField, PasswordField,
  ErrorBanner, EmptyState, StatusDot/Badge, ConfirmationSheet, CopyButton, Skeleton, Toast,
  HapticPressable, code/fingerprint block.
- [ ] Native settings navigation with nine real sections and optional admin destination.
- [ ] Signed-in navigation destinations for Archived, Legion, Settings, Profile and Logout;
  searchable archive with Restore/Delete forever.
- [ ] Physical-iPhone Expo Go acceptance matrix explicitly excluding OAuth callback, WebAuthn PRF,
  Face ID-gated secrets and remote push.

### 19.2 Auth screens

- [ ] **Login:** Auth shell; provider availability area; Email; Password; Forgot; busy/error;
  Create one; keyboard next/submit; post-login /app resolver.
- [ ] **Signup:** config loading/error/retry; invite callout; providers; Email; Password+8 hint;
  conditional Invite; exact errors; Login.
- [ ] **Forgot Password:** Email; enumeration-resistant sent state; Back.
- [ ] **Reset Password:** missing-token state; New/Confirm; 12-character and match validation;
  sign-out-all notice; one-use/expired errors.
- [ ] **Verify Email Link:** automatic one-shot confirm; working/success/error; host gate resolver.
- [ ] **Provider OAuth installed-build screen:** external auth session, transaction exchange,
  cancel/error. Expo Go unavailable state.
- [ ] **Expired session:** one-shot reason banner, stack reset.

### 19.3 Onboarding and pairing

- [ ] **Onboarding container:** derived Account/Verify/Host/Done; progress rail; loading failures;
  900ms success beats.
- [ ] **Account step:** shared Signup form and invite behavior.
- [ ] **Verify step:** email card, five-second foreground polling, Resend/429.
- [ ] **Host instruction:** explicitly “on a Mac or Linux machine”; deployment command;
  Copy+Share; spawnd login instruction; Windows/iPhone caveat.
- [ ] **Pair code:** 4-4 code field; uppercase/trim; review fetch; all exact server states.
- [ ] **Fingerprint review:** host name/key fingerprint, local pin state, phone device fingerprint,
  Back/Approve/retry.
- [ ] **Waiting host:** host polling; online success; skip-for-now.
- [ ] **Done:** create first workspace/session when appropriate; retry; correct final replace.

### 19.4 Settings and profile

- [ ] **Settings root:** nine entries, native swipe between sections if desired, deep internal route.
- [ ] **Account:** email, verify callout, logout, two-field destructive deletion/wipe.
- [ ] **Appearance:** Light/Dark/System radios; live OS subscription; terminal restyle.
- [ ] **Notifications:** three event toggles, four channels, permissions/support copy, stream state,
  test alert, per-session mute integration.
- [ ] **Hosts settings:** sorted/polled list, row facts, inline rename, removal confirmation,
  Connect Host.
- [ ] **Agents:** built-in/custom groups; yolo; add/edit fields/env rows; validation; delete confirm.
- [ ] **Skills:** inline add/edit form; default checkbox; rows; delete confirmation.
- [ ] **Templates:** rows+summary; icon picker; rename; delete; links to workspace create/save flows.
- [ ] **Devices:** registration/reconciliation; list/trust badges; rename; approve endorsement;
  revoke/local cleanup; fresh identity; revoked history/prune.
- [ ] **Trust:** local/bundle summary; installed-build passkey actions; Expo Go unavailable
  explanation; forget local trust; diagnostics.
- [ ] **Profile sheet:** identity/streak; Account settings; legion totals; machines; 120-day heatmap;
  lifetime stats; agents; Copy stats.

### 19.5 Hosts, fleet, files

- [ ] **Host list:** name/status/system/daemon/session count; details; rename; remove; empty/error.
- [ ] **Host detail:** six facts; 30s host poll; 5s session poll; rename/remove/files; offline state.
- [ ] **Host agent availability:** check/refresh; install/update confirmation; auto-update; output;
  offline/timeouts.
- [ ] **Host sessions:** icon/status/title/agent/cwd/activity; terminal overlay navigation.
- [ ] **Host files:** path link; tree/breadcrumb; upload/new folder/refresh/collapse; preview;
  rename/delete/download/copy/reveal/open; host transfer; large-file confirmation.
- [ ] **Legion:** totals, cards, capacity labels, session/attention derivation, empty possess actions.
- [ ] **Legion live mode:** direct daemon metrics, privacy callout, teardown on leave, unavailable.

### 19.6 Admin and public

- [ ] **Admin guard/chrome:** hide for nonadmin; safe Nothing here state.
- [ ] **Invites:** optional email, 1–720 hour expiry, one-time URL copy/dismiss, states/revoke.
- [ ] **Users:** read-only identity/admin/verified/counts list.
- [ ] **Email admin:** delivery status, test, expandable redacted logs.
- [ ] **Install help/Download:** platform support matrix, normal/prebuilt commands, Copy/Share.
- [ ] **Security/About:** static mechanism/threat-model content and signup/install actions.

## 20. Owner decisions required before implementation

1. Approve a server-side mobile refresh/revoke contract; otherwise native sessions expire after 15
   minutes or depend on undocumented cookie persistence.
2. Approve a one-time-code/PKCE native OAuth callback design and accept that OAuth cannot work in
   generic Expo Go.
3. Decide whether closed deployment OAuth creation should require an invitation.
4. Decide whether remote/background push is v1 scope. It needs new server delivery/storage and an
   installed build; foreground alert parity works in Expo Go.
5. Decide the installed-build WebAuthn-PRF strategy. Expo Go must use endorsement/direct pairing and
   show passkey trust recovery as unavailable.
6. Approve Admin deferral or require its three documented list sections for literal parity.
7. Supply production domain, scheme, bundle/package identifiers and signing identities for
   universal/app links.
8. Confirm that daemon restart/update/logs remain out of scope because no reference contract exists.
