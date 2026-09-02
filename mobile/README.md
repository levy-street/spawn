# spawn for iPhone

This directory contains the Expo SDK 54 native client for spawn. It is designed to run in the
public Expo Go app on an iPhone without a custom native build.

## Prerequisites

- Node `22.19.0` or newer in the Node 22 line (the package requires `>=22.19.0 <23`) and its npm.
- Expo Go with the SDK 54 runtime. The target App Store build is Expo Go `54.0.2`; confirm the app
  reports SDK 54 before scanning the project QR code.
- A Mac and iPhone on the same routable Wi-Fi network for the normal LAN path.
- A spawn server that the iPhone can reach. A public or locally trusted HTTPS origin is the most
  reliable choice.

You do not need a globally installed Expo CLI. The commands below use the project-local CLI
through `npx`.

## 1. Point the app at your server

An iPhone cannot reach a server at `localhost`; on the phone, `localhost` means the phone itself.

### Running against a local dev server (the usual case)

The app derives its default API origin from the Metro host Expo Go connected to — which is your
Mac's LAN address — and appends port **8010**, the port `scripts/dev.sh` serves. So on the LAN
this needs **no configuration at all**.

The one thing you must do is let the dev API listen on more than loopback. `scripts/dev.sh` binds
`127.0.0.1` by default; start it like this instead:

```bash
SPAWN_DEV_API_HOST=0.0.0.0 ./scripts/dev.sh
```

Then confirm from the phone: open `http://<your-mac-lan-ip>:8010/healthz` in Safari on the
iPhone. If that does not load, the app cannot reach it either, and the problem is the network or
the bind — not the app.

`dev.sh` also sets `SPAWN_REQUIRE_EMAIL_VERIFICATION=false`, so local signup skips the email step.

### Pointing at any other server

Use **Settings → Server** in the app. It is also reachable **before signing in**, via the
"Server" control on the login screen — a wrong URL would otherwise be a deadlock, since signing in
is what you need the setting for. The panel shows the currently effective URL and where it came
from, and offers a "Test connection" action that reports the real error.

Enter the server origin only, without `/api`, credentials, a query, or a fragment. Both `http` and
`https` work, though HTTPS avoids iOS transport-security friction.

To bake in a default instead, add `extra.apiUrl` inside the `expo` object in `app.json`. Note that
doing so **overrides the LAN derivation above**, so leave it unset while developing locally.

The resolution order is:

1. A runtime override persisted from Settings → Server.
2. `expo.extra.apiUrl` from `app.json`, if set.
3. The Metro-host-derived LAN default, `http://<metro-host>:8010`.
4. `http://localhost:8010` when the host cannot be derived (simulator).

Credentials are stored per normalized server URL, so a token for one server is never sent to
another.

Before opening the app, load `https://your-server.example/healthz` in Safari on the iPhone. This
checks phone-to-server routing and TLS independently of Metro.

## 2. Install and start

From this directory:

```sh
npm install
npx expo start --lan
```

Keep that terminal open. Unlock the iPhone, open the Camera app, scan the QR code, and accept the
prompt to open it in Expo Go. You can also scan from Expo Go's project screen. Allow Expo Go local
network access when iOS asks.

The first bundle can take longer than a refresh. Once it has loaded, later source changes should
refresh through Metro.

### If LAN mode cannot connect

First check that both devices are on the same Wi-Fi, VPNs are disabled, the network does not use
client isolation, and the macOS firewall allows Node/Expo. Then try the tunnel transport:

```sh
npx expo start --tunnel
```

The tunnel carries the Metro JavaScript bundle only. It does not make a private spawn server or
daemon reachable from the phone; the configured `apiUrl` must still be routable from iOS.

## 3. Sign in and complete first-run setup

1. Sign in with email and password, or create an account.
2. If the server requires email verification, confirm the message and return to the app.
3. The app creates and registers this phone's device identity.
4. If the account has no host, follow the host install instructions. The installer opens an
   approval link; open it on this phone and compare the displayed fingerprints before approving.
   You may skip possessing a host and return to it later.
5. After setup, the four native roots are Workspaces, Hosts, Files, and Settings.

OAuth buttons are intentionally unavailable in Expo Go. Use email and password.

## 4. Check the terminal secure context first

The iOS bundle and unit tests cannot prove that WKWebView grants WebRTC DataChannels to bundled
HTML. This is the campaign's highest-priority physical-device check.

1. Open a workspace and a live session.
2. Tap **Terminal actions** (the ellipsis in the terminal header).
3. Choose **Diagnostics**.
4. Confirm these rows report **Available**:
   - Secure context
   - Peer connection
   - Data channel
   - Loopback
5. The Renderer row may report `webgl` or `dom`; `dom` is the supported fallback.
6. Confirm the terminal reaches `ready`, renders output, and accepts a short input command.

If any capability is unavailable, record every diagnostics row, the Worker detail, the iOS
version, and the Expo Go version. A secure-context failure is different from an API, authentication,
ICE, or daemon connectivity failure. The architecture guide describes the inline-worker and file
fallback boundary.

## Known Expo Go limitations

- Passkeys/WebAuthn PRF trust bundles are unavailable. Device endorsement and manual host pairing
  remain supported.
- Remote push notifications are unavailable, and spawn has no remote-push backend. Local alerts
  are supported.
- Google, Microsoft, and GitHub OAuth cannot return through the server's relative callback path.
  Email/password authentication is supported.
- Face-ID-gated SecureStore behavior cannot be qualified in Expo Go. Credentials use ordinary
  SecureStore for this build.
- Expo Go does not faithfully preview a standalone app's final native splash behavior.

## Troubleshooting

### Expo Go says the SDK is unsupported

Confirm `package.json` uses Expo 54 and the installed Expo Go app reports SDK 54. Run:

```sh
npx expo-doctor
```

Do not mix packages from a newer Expo SDK into this project.

### Metro shows a stale or inconsistent bundle

Stop the existing Metro process, then restart with a clean cache:

```sh
npx expo start --clear --lan
```

Use `--tunnel` instead of `--lan` if the LAN remains unreachable.

### The QR opens, but the phone cannot reach Metro

- Keep the Mac awake and on the same network as the phone.
- Disable VPNs or routes that move either device onto another interface.
- Avoid guest Wi-Fi and corporate networks with wireless client isolation.
- Allow incoming connections for Node/Expo in the macOS firewall.
- Try a phone hotspot or `--tunnel` to distinguish local routing from an app problem.

### Sign-in or data loading fails

- Verify the effective server URL (Settings → Server) is reachable from Safari on the iPhone.
- Do not use `localhost`, `127.0.0.1`, or a Mac-only hostname.
- Confirm the server certificate is trusted by iOS and `/healthz` responds.
- Restart Metro after changing `app.json`; use `--clear` if the old value persists.
- Remember that the Metro tunnel does not tunnel the spawn API.

### The app opens to a red screen or blank screen

Copy the first Metro exception, including its module name and import chain. Then run the automated
preflight from this directory:

```sh
npm run typecheck
npm run lint
npm test
npx expo export --platform ios
```

See `docs/architecture.md` for the subsystem that owns each failure class.

### Terminal diagnostics pass, but the session does not connect

The WebView runtime is capable, so inspect authentication, the browser signalling socket, host
identity/pins, ICE reachability, and daemon state. The capability probe is local and does not prove
the server-to-daemon path.
