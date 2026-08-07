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

## Amazon SES, step by step

SES is the cheapest option at volume ($0.10 per thousand) and needs no third
party if you already host on AWS. It has one sharp edge: **new accounts are
sandboxed and can only send to addresses you have verified**, which is
useless for inviting people. Leaving the sandbox is a support request that
usually clears within 24 hours, so start it first.

Use the same region as the server; these commands assume `us-east-1`.

### 1. Verify the sending domain (publishes DKIM)

Console: **SES → Identities → Create identity → Domain**, enter your domain,
keep **Easy DKIM** with 2048-bit keys, and — if the domain's hosted zone lives
in the same AWS account — tick **Publish DNS records to Route 53**. That
writes the three DKIM CNAMEs for you and is the whole reason this is easy.

Equivalent CLI, from credentials that may touch SES and Route 53:

```
aws sesv2 create-email-identity   --email-identity example.com   --dkim-signing-attributes NextSigningKeyLength=RSA_2048_BIT   --region us-east-1
```

If you did not let SES publish them, fetch the records and add them yourself:

```
aws sesv2 get-email-identity --email-identity example.com   --region us-east-1 --query DkimAttributes.Tokens --output text
```

Each token `T` becomes `T._domainkey.example.com CNAME T.dkim.amazonses.com`.
Verification flips to `Success` within minutes of the records resolving.

### 2. Add SPF and DMARC

Neither is created for you:

```
example.com            TXT  "v=spf1 include:amazonses.com ~all"
_dmarc.example.com     TXT  "v=DMARC1; p=none; rua=mailto:you@example.com"
```

If a TXT record already exists on the apex, merge the SPF into it rather than
adding a second one — two SPF records is a hard failure, not a warning.

### 3. Leave the sandbox (check first — you may already have)

Production access is granted per AWS account **and per region**, as are domain
identities and SMTP credentials. An account that left the sandbox for another
product in one region is still sandboxed everywhere else, which is an easy
half-day to lose. Check before requesting:

```
aws sesv2 get-account --region <region> --query ProductionAccessEnabled
aws sesv2 list-email-identities --region <region> --query 'EmailIdentities[].IdentityName'
```

If another region already has it, point this deployment there instead of
filing a second request — the server's own region does not constrain which
SES region it talks to; only `SPAWN_SMTP_HOST` changes. Generate the SMTP
credentials in whichever region you settle on: the password is derived using
the region and does not carry across.

If you do need to request it:

**SES → Account dashboard → Request production access.** Vague requests get
rejected; say specifically what you send and how you handle bounces. For a
deployment like this one, that is: transactional only (password resets,
address verification, and invitations the recipient asked for), no marketing,
no purchased lists, recipients are people who created an account or were
invited by an admin, and every send is logged.

Until this is approved you can only mail addresses verified as SES
identities — verify your own address so you can test end to end meanwhile.

### 4. Create SMTP credentials

**SES → SMTP settings → Create SMTP credentials.** This makes an IAM user with
`ses:SendRawEmail` and derives an SMTP username and password from it. They are
**not** your AWS access keys, and the password is shown exactly once.

### 5. Point spawn at it

```
SPAWN_EMAIL_BACKEND=smtp
SPAWN_EMAIL_FROM=spawn <no-reply@example.com>
SPAWN_SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SPAWN_SMTP_PORT=587
SPAWN_SMTP_USERNAME=<SMTP username from step 4>
SPAWN_SMTP_PASSWORD=<SMTP password from step 4>
SPAWN_SMTP_USE_STARTTLS=true
```

Restart `spawn-server`, then **Admin → Email → Send test email**. The most
common failures and what they mean:

- `554 Message rejected: Email address is not verified` — still in the
  sandbox, or the From address is not on the verified domain.
- `535 Authentication Credentials Invalid` — using AWS access keys instead of
  the SMTP credentials from step 4.
- Connection timeout — port 587 blocked outbound; try 2587, which SES also
  serves.

### A note on credentials

The server holds a static SMTP password under this setup. SES can also be
driven by the instance's IAM role with no stored secret at all, which is
strictly better — it needs an SES API backend rather than SMTP, which this
project does not implement yet. Worth doing if you stay on SES.

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
