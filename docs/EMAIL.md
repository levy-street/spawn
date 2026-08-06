# Outbound email

Password resets, address verification, and invitations all need working
delivery. Until it is configured the backend is `console`: every message is
recorded and logged, and **nothing is sent** — which the admin dashboard
states plainly rather than looking healthy.

## Configure delivery

Set these in `server/.env` and restart `spawn-server`:

```
SPAWN_EMAIL_BACKEND=smtp
SPAWN_EMAIL_FROM=spawn <no-reply@yourdomain>
SPAWN_SMTP_HOST=<provider smtp host>
SPAWN_SMTP_PORT=587
SPAWN_SMTP_USERNAME=<provider username>
SPAWN_SMTP_PASSWORD=<provider password or API key>
SPAWN_SMTP_USE_STARTTLS=true          # port 587
# SPAWN_SMTP_USE_SSL=true             # port 465 instead
```

Then open **Admin → Email → Send test email**. It reports the transport error
verbatim on failure, which is the fastest way to tell a wrong password from a
blocked port.

## Choosing a provider

Any SMTP provider works; there is no vendor lock-in here. Practical notes:

- **Resend** — fastest to set up, generous free tier. Host `smtp.resend.com`,
  port 587, username `resend`, password = API key.
- **Postmark** — the best deliverability for transactional mail, paid from the
  start. Host `smtp.postmarkapp.com`, port 587, username and password are both
  the server API token.
- **Amazon SES** — cheapest at volume and already in the same account if you
  host on AWS, but new accounts start in a sandbox that only sends to verified
  addresses; leaving it requires a support request. Use the regional endpoint
  (e.g. `email-smtp.us-east-1.amazonaws.com`) with SES **SMTP credentials**,
  which are not your AWS access keys.

Avoid personal Gmail/Fastmail accounts: they rate-limit hard, rewrite the From
address, and mark mail from an unfamiliar server as spam.

## Make the mail arrive

Deliverability is DNS, not code. Publish, on the sending domain:

- **SPF** — a TXT record authorising the provider, e.g.
  `v=spf1 include:<provider> ~all`.
- **DKIM** — the CNAME or TXT records the provider generates. This is the one
  that matters most; unsigned mail from a new domain lands in spam.
- **DMARC** — start with `v=DMARC1; p=none; rua=mailto:you@yourdomain` and
  tighten to `p=quarantine` once reports look clean.

Send yourself a test and check it arrived in the inbox rather than spam before
inviting anyone.

## What is recorded

Every attempt is written to the email log (Admin → Email) with recipient,
subject, kind, status, and any transport error — including messages the
`console` backend never sent, so a misconfigured deployment is visible rather
than silent.

Bodies are stored **with credentials redacted**: `token=` and `invite=` values
are replaced before the row is written. A reset link admits whoever holds it,
so a log that stored them verbatim would be a durable account-takeover vault
for anyone who reached the database or the admin page. The prose is kept; the
secret is not.
