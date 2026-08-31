# Notifications while SPAWN D is closed

`/ws/alerts` reaches a client that is holding a socket, which is the one
client that does not need telling: if the tab is open in front of you, you can
already see the session finish. An alert has to arrive for the phone in your
pocket and the laptop you shut an hour ago, and reaching those means handing
the message to something that stays connected on their behalf.

There are two such services and they are configured separately.

| Client | Service | Configuration |
| --- | --- | --- |
| The phone app | Expo, which fronts APNs and FCM | signing keys live with the EAS project; nothing is required here |
| A browser | the push service the browser's own vendor runs | a VAPID key pair, below |

Neither is required. A server with neither configured simply has no remote
alerts, says so, and works. This is the normal state of a development machine.

The content rule is the same on both and is not negotiable: read the docstring
at the top of `server/spawn_server/push.py`. A notification renders on a lock
screen, in front of whoever is holding the machine, so the only session-derived
string that goes out is `command`. Web Push payloads are encrypted end to end,
which protects them from the push service and not at all from the room.

## Web Push: generate the key pair

VAPID (RFC 8292) is how the server proves to a browser's push service that it
is the same server the browser subscribed to. It is one P-256 key pair, held
by the server and never rotated casually — **rotating it invalidates every
existing browser subscription**, because the subscription is bound to the
public key the browser passed to `pushManager.subscribe`. Every browser then
has to subscribe again, and until it does it silently receives nothing.

Generate one with OpenSSL — no extra tooling, and the output is the PKCS#8 PEM
the server reads:

```bash
openssl ecparam -name prime256v1 -genkey -noout \
  | openssl pkcs8 -topk8 -nocrypt -out vapid-private.pem
```

The public half is derived from it; you never configure it separately, and the
browser fetches it from `GET /api/notifications/web-push/key`.

If you already have a key pair from the JavaScript tooling
(`npx web-push generate-vapid-keys`), the private key it prints is the raw
32-byte scalar as base64url. Paste that instead of a PEM — the server accepts
either shape.

## Web Push: configure the server

Set these in `server/.env` and restart `spawn-server`:

```
# The PEM as one value. Escaped \n are accepted, for secret stores that
# flatten newlines on the way through.
SPAWN_VAPID_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIGHAgEA...\n-----END PRIVATE KEY-----"

# Who a push service contacts if this server misbehaves. A mailto: or https:
# URI (RFC 8292). Set a real mailbox: the fallback is SPAWN_PUBLIC_URL, which
# is valid and tells nobody anything.
SPAWN_VAPID_SUBJECT=mailto:ops@yourdomain
```

The key is a secret. It never goes in git, and `.env.example` carries only the
empty names.

To turn the browser channel off again, clear `SPAWN_VAPID_PRIVATE_KEY`.
`SPAWN_PUSH_ENABLED=false` turns off both channels at once.

## Verifying it

```bash
curl -H "Authorization: Bearer <token>" https://<host>/api/notifications/web-push/key
```

- `{"enabled": true, "public_key": "B..."}` — configured; the 87-character
  value is the application server key browsers subscribe with.
- `{"enabled": false, "public_key": null}` — no usable key. Either none is
  set, or the one that is set could not be parsed; the server logs which at
  `WARNING` under `spawn.push.web` and carries on without the channel rather
  than failing requests.

A browser that subscribes against one public key and then meets a server
holding a different one gets `403` from its push service on every send. The
server logs that as `web push rejected our VAPID credential` and leaves the
subscription alone, because it is this server's configuration that is wrong,
not the browser. Rotating the key means every browser must re-subscribe.

## What the server does with failures

- **404 or 410** — the subscription is gone. The row is switched off, never
  deleted, so a browser that subscribes again updates it.
- **429** — the service asked to be left alone. `Retry-After` is honoured
  (clamped between 30 seconds and 6 hours) and the subscription is skipped
  until then.
- **Anything else** — logged and retried on the next alert. A push service
  having a bad afternoon is not a browser that unsubscribed.

Undelivered alerts expire after 15 minutes (`TTL`). An attention alert that
surfaces four hours late is noise, and the session list is the durable record.
