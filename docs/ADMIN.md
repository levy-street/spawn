# Admin surface

## What it is

`/admin` lists every account on the deployment and manages signup invites.
Access is the `is_admin` flag on the account, checked by the API on every
request; non-admins get `404` (not `403`) so the surface does not announce its
own existence.

`admin.<your-domain>` serves the same pages from a separate origin, which also
means a separate cookie jar — signing in there does not reuse the product
session. The hostname is packaging: `/admin` on the main origin is equally
guarded, and the admin subdomain is equally useless to a non-admin.

## Becoming an admin

Two bootstraps, so nobody ever edits database rows by hand:

- **First account wins.** The first account created on an empty deployment is
  its owner. (A closed deployment also lets that first signup through without
  an invite — there is nobody who could have issued one.)
- **`SPAWN_ADMIN_EMAILS`** — a comma-separated list. A matching address is
  promoted on signup and on every login. It only ever grants; the database
  flag stays the source of truth so admin can be handed out or taken back at
  runtime.

## Invites

`SPAWN_INVITE_ONLY=true` (the default) closes signup. An invite is a bearer
credential: whoever holds the link can create one account.

- Single use, expiring (`SPAWN_INVITE_DEFAULT_TTL_HOURS`, default 72),
  revocable.
- Stored as a SHA-256 hash. The link is shown **once**, in the response that
  created it — a reload cannot recover it, and a database leak does not hand
  anyone the ability to mint accounts.
- Addressing an invite to an email sends it (when SMTP is configured) *and*
  returns the link, so an admin can always hand it over directly.
- Signup refuses every invalid code with one message, so probing codes reveals
  nothing about which exist.

## Serving admin.<domain>

1. **DNS**: an `A` record for `admin.<domain>` pointing at the same host.
2. **TLS + vhost**: `sudo certbot --nginx -d admin.<domain>`, or add the
   server block in `infra/nginx-admin.conf.example` and issue the certificate
   separately.
3. Add `https://admin.<domain>` to `SPAWN_CORS_ORIGINS`.

Until DNS exists, everything works at `https://<domain>/admin`.
