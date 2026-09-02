# Billing — SPAWN D subscriptions

The complete design for host-limit subscriptions on the hosted instance. Read
this before touching anything under "Surfaces"; the enforcement design in §4 is
what makes the rest safe, and several surfaces look like the obvious place for a
gate and are deliberately not.

**Nothing in this document applies to a self-hosted deployment.** Billing is off
unless `SPAWN_BILLING_ENABLED=true`, and off means no limit, no UI, no Stripe
calls, and no new columns consulted. See §3.1.

---

## 1. The product

### 1.1 Tiers

| Tier | Price | Hosts | Stripe |
|---|---|---|---|
| **Free** | $0 | 1 | no subscription row |
| **Coven** | $5/mo USD | 3 | Product + Price |
| **Legion** | $20/mo USD | 20 | Product + Price |
| **Pandemonium** | $50/mo USD | unlimited | Product + Price |

Monthly only. USD only. No annual, no trials, no seats, no metered usage.

> **Naming collision, handled deliberately.** `/legion` is already the fleet
> page and `components/legion/` is already a component family. The tier is
> therefore **always written "the Legion plan"** — never bare "Legion" — in every
> string a person reads, and the code name for it is `TIER_LEGION` with the
> plan-tier enum value `"legion"`. The fleet page keeps its noun untouched. A
> string that says just "Legion" in a billing context is a bug.

### 1.2 The rules

1. **A host is a registration, not a machine.** `spawnd possess --new-account`
   legitimately puts two `Host` rows on one laptop
   (`daemon/src/possess.rs:320`). Rows are the only thing the server can count,
   and the pricing page says so in as many words.
2. **The limit governs admitting a new host, never using an existing one.** A
   machine already possessed keeps working forever, through downgrade, through
   a failed payment, through cancellation. There is no suspend state and we are
   not building one — see §11.2.
3. **Downgrades are always allowed.** The user chooses which hosts to keep; we
   never refuse the plan change. §5.6.
4. **The app says nothing about billing until the moment it must** — the point
   where someone tries to add a host past their limit. No upsell in the sidebar,
   no plan badge in the nav, no "upgrade" nag. The Subscription settings panel
   and the pricing page are the only places billing exists unprompted.
5. **Comped accounts never see any of it.** §4.8.

---

## 2. What I need from you

### 2.1 Blocking — nothing can ship without these

| # | Item | Why |
|---|---|---|
| 1 | A Stripe account, activated (business details + bank account) | No account exists today. Live mode needs activation; test mode does not, so development starts immediately. |
| 2 | `/terms` and `/privacy` content signed off | Stripe requires both URLs to activate. App Store Connect requires a privacy policy URL before a build submits. Google Play requires one on the listing. §5.2. |
| 3 | The five env values, test mode first | §2.3. |
| 4 | A decision on Stripe Tax | §2.4. |

### 2.2 The Stripe dashboard checklist

Do this in **test mode** first; every step repeats in live mode later, and the
IDs differ between modes.

1. Create the account. Business type, country, and a statement descriptor —
   the descriptor is what appears on a card statement, so make it recognisably
   `SPAWND` or `SPAWN D`.
2. **Settings → Public details**: support email, support URL. These appear in
   the Customer Portal and on receipts.
3. **Settings → Legal**: terms of service URL and privacy policy URL. These are
   the pages from §5.2 and are required for activation.
4. **Products** — create three, each with exactly one monthly USD price. They
   must be three separate Products, not one Product with three prices: the
   Customer Portal cannot offer two prices that share a product and a billing
   interval, which would break plan switching.

   | Product name | Price | `lookup_key` | `metadata.host_limit` |
   |---|---|---|---|
   | `SPAWN D — Coven` | $5.00 / month | `spawnd_coven_monthly` | `3` |
   | `SPAWN D — Legion` | $20.00 / month | `spawnd_legion_monthly` | `20` |
   | `SPAWN D — Pandemonium` | $50.00 / month | `spawnd_pandemonium_monthly` | `0` (0 = unlimited) |

   Set **`tax_behavior` explicitly and identically on all three** at creation.
   It is immutable afterwards, and the Portal refuses plan switches between
   prices whose `tax_behavior` differs or is `unspecified`.

   `metadata.host_limit` is convenience only — **the server never trusts it**.
   The limit comes from our own price-ID→tier map (§4.1). Stripe metadata is
   editable in a dashboard by anyone with access and is not an authority.
5. **Customer Portal** (Settings → Billing → Customer portal):
   - Invoice history: **on**
   - Payment method update: **on**
   - Cancel subscription: **on**, at period end, with reason collection
   - **Plan switching: OFF.** This is deliberate and load-bearing — see §5.6.
     We do plan changes in our own UI so we can run the host-selection step
     first. Leaving it on gives users a second, unguarded downgrade path.
6. **Webhook endpoint**: `https://spawnd.dev/api/billing/webhook`, subscribed to
   exactly the events in §4.6.1. Copy the signing secret.
7. **Branding**: logo and accent colour, so Checkout and the Portal don't look
   like a different company.

### 2.3 The values to send me

Test mode first. Never paste live keys into a chat, a commit, or an issue —
they go straight into the server's `.env` on the box.

```
SPAWN_STRIPE_SECRET_KEY=sk_test_…
SPAWN_STRIPE_WEBHOOK_SECRET=whsec_…
SPAWN_STRIPE_PRICE_COVEN=price_…
SPAWN_STRIPE_PRICE_LEGION=price_…
SPAWN_STRIPE_PRICE_PANDEMONIUM=price_…
```

No publishable key is needed: Checkout is a server-created redirect, so no
Stripe JS runs in our pages and no key reaches the browser.

### 2.4 Decisions still open

- **Stripe Tax on or off?** On means Stripe computes and collects VAT/sales tax
  and you register where you cross thresholds; off means every price is
  tax-inclusive and you carry the liability. For a $5 product selling into the
  EU and UK, on is the safer default, but it is a real compliance commitment.
  I have built the plan so this is a Stripe-side setting and changes no code.
- **Refund policy wording** for `/terms`. Stripe does not require a specific
  policy, but EU/UK law gives consumers a 14-day withdrawal right on digital
  services unless they expressly waive it, and the waiver has to be collected
  at checkout. §5.2.
- **The `from` address for billing email.** `mail.py` already exists; billing
  receipts come from Stripe, but our own limit/upgrade emails come from us.

---

## 3. Principles this feature is held to

These come from `docs/TRUST.md` and the existing code, and each one rules out
something a naive billing integration would do.

### 3.1 Absent configuration is a supported state, not an error

`SPAWN_BILLING_ENABLED` defaults to **false**. A self-hoster does nothing and
gets unlimited hosts and no billing UI anywhere. This mirrors the established
idiom — an OAuth provider's button appears only when both of its values are set,
Web Push is inert without a VAPID key, TURN is optional.

`config.is_local_deployment()` looks like the right hook and **is not**: it
answers "is this a laptop or a LAN address", so a self-hoster on a real domain
would read as hosted and get billed.

### 3.2 A gate nobody can pass is an outage, not a control

`auth.py:206-211` makes email verification deliberately inert when mail cannot
be delivered, because *"enforcing the requirement there would lock every new
account out of the product permanently with no path forward"*. The same rule
governs billing: if Stripe is unreachable, entitlement is read from **our**
database, which is the authority at enforcement time. Stripe being down changes
nothing about whether an existing customer can pair a host.

### 3.3 The client mirrors; the server decides

`AuthConfigOut`'s docstring states the rule: the advertised flag mirrors the
exact condition the server enforces, so a client never shows a gate the server
won't apply. Hiding a button is presentation. The limit lives at
`routes/device.py`.

### 3.4 Never trust a client's or a webhook's claim about a plan

`host_capacity.py:3-6` — *"Nothing a daemon sends is trusted into a column
unchecked."* The billing analogue: a tier is never read from a request body, a
success-redirect query param, or a webhook payload's own assertion. It is read
from Stripe's API (or from a signature-verified event whose subscription we then
re-fetch) and mapped through **our** price-ID table.

### 3.5 Refuse to boot on a dangerous misconfiguration

`config.py:249` already refuses to start on development defaults in production.
Billing adds one more: **`SPAWN_BILLING_ENABLED=true` with an empty
`SPAWN_STRIPE_WEBHOOK_SECRET` must refuse to boot**, because the alternative is
an endpoint that accepts unsigned webhooks — an unauthenticated
"make me a Pandemonium subscriber" API.

### 3.6 The metadata inventory stays honest

`docs/TRUST.md:116` maintains an explicit list of everything the server durably
holds about an account, and the document stakes a careful claim: *"the server
cannot see your protected content (cryptographic), not merely does not look
(policy)"*. A Stripe customer ID, a plan tier and a renewal date are new durable
per-account data. **`docs/TRUST.md` gains a "Billing (2026-08-31)" section in
the same commit**, in the style of the existing "Host capacity (2026-08-21)"
entry: what is stored, why, what it is not, and that it is absent entirely on a
self-hosted install.

---

## 4. Server

### 4.1 Config — `spawn_server/config.py`

Added to `Settings` (env prefix `SPAWN_`, so `billing_enabled` is
`SPAWN_BILLING_ENABLED`):

```python
billing_enabled: bool = False
stripe_secret_key: str | None = None
stripe_webhook_secret: str | None = None
stripe_price_coven: str | None = None
stripe_price_legion: str | None = None
stripe_price_pandemonium: str | None = None
# Where Checkout returns the browser. Defaults to `web_url` when unset.
billing_return_url: str | None = None
```

Plus a model validator in the style of
`_refuse_development_defaults_off_a_laptop` (`config.py:249`):

```python
@model_validator(mode="after")
def _refuse_billing_without_its_secrets(self) -> "Settings":
    """Billing on with no webhook secret is an unauthenticated grant API.

    A webhook endpoint that cannot verify a signature will accept anybody's
    POST claiming anybody's subscription. Refusing to boot is the only safe
    reading of that configuration; the alternative is a warning in a log
    nobody reads and a paid tier anyone can mint.
    """
```

It must also refuse when `billing_enabled` is true and any of the three price
IDs or the secret key is empty — a half-configured catalogue means a tier that
cannot be bought and an upgrade button that 500s.

`get_settings()` is `@lru_cache`d (`config.py:334`), so every one of these is
read once per process. Tests must `get_settings.cache_clear()` after
`monkeypatch.setenv`, as `tests/test_config.py` already does.

**`.env.example`** gains a commented block beside the VAPID one, explaining that
absent means self-hosted and unlimited.

### 4.2 Data model — `spawn_server/models.py`

One new table. House style: `String(36)` UUID PKs with `default=_new_uuid`,
`DateTime(timezone=True)` throughout, and enums as `String(n)` plus a
`CheckConstraint`, never SQLAlchemy `Enum` (the precedent is
`DeviceApprovalRequest`, `models.py:592`).

```python
class Subscription(Base):
    """What an account is entitled to, and the Stripe object that says so.

    One row per account that has ever had a paid plan; absent means Free. The
    row survives cancellation so the Stripe customer id is stable across a
    resubscribe — a second Customer for the same person would split their
    invoice history and break the portal.

    `tier` and `host_limit` are OUR reading of Stripe's price id, never a value
    Stripe sent us. `status` mirrors Stripe's subscription status verbatim so a
    support question can be answered without opening the dashboard.
    """
    __tablename__ = "subscriptions"

    id:                     String(36) PK
    user_id:                String(36) FK users.id ondelete=CASCADE, UNIQUE, index
    stripe_customer_id:     String(64) NOT NULL, UNIQUE, index
    stripe_subscription_id: String(64) NULL, UNIQUE
    tier:                   String(16) NOT NULL default "free"
    status:                 String(24) NOT NULL default "incomplete"
    host_limit:             Integer NULL      # NULL = unlimited
    current_period_end:     DateTime(tz) NULL
    cancel_at_period_end:   Boolean NOT NULL default False
    # Ordering guard. Stripe does not promise ordered delivery; an event whose
    # subscription was updated before the one we already applied is dropped.
    last_event_at:          DateTime(tz) NULL
    created_at / updated_at

    CheckConstraint("tier IN ('free','coven','legion','pandemonium')")
    CheckConstraint("host_limit IS NULL OR host_limit >= 0")
```

```python
class StripeEvent(Base):
    """Every webhook id we have already applied, so a redelivery is a no-op.

    Stripe retries for up to three days and can deliver the same event more
    than once. The unique index IS the idempotency mechanism: the handler
    inserts first and treats an IntegrityError as "already done".
    """
    __tablename__ = "stripe_events"

    id:         String(64) PK      # Stripe's evt_… id
    type:       String(64) NOT NULL
    received_at: DateTime(tz) NOT NULL
```

And one column on `User`, for comped accounts (§4.8):

```python
# NULL = no override. 0 = unlimited. Set only by an admin; never by Stripe,
# never by a webhook, never by the account itself.
host_limit_override: Mapped[int | None]
```

**Why an override column and not `is_admin`:** overloading the admin flag to
mean "free unlimited hosts" welds two unrelated authorities together, so
granting someone the admin UI would silently grant them unlimited hosts, and
comping a customer would hand them the admin surface. They are different
questions and get different columns.

### 4.3 Migration — `alembic/versions/0068_billing.py`

Single head today is `0067`; `down_revision = "0067"`. Additive only: two new
tables and one nullable column, so old code tolerates the new schema and the
migration is safe to run while previous processes drain (`docs/RELEASE.md`).

Write a real `downgrade()`, and a prose docstring in the style of
`0066_web_push_subscriptions.py` — the local convention is that a migration
explains *why* the table exists, not just what it creates. Partial indexes need
both `sqlite_where` and `postgresql_where` (tests run SQLite, production is
Postgres).

No data migration and no grandfathering: the hosted instance is invite-only and
not in production use, so no account is over the new limit on day one.

### 4.4 `spawn_server/billing.py` — the entitlement module

Pure functions plus DB reads; no Stripe calls. This is the module every
enforcement point uses, and it is the only place that knows what a tier means.

```python
TIERS = {
    "free":        Tier(name="Free",        host_limit=1,    price_id=None),
    "coven":       Tier(name="Coven",       host_limit=3,    price_id=…),
    "legion":      Tier(name="Legion",      host_limit=20,   price_id=…),
    "pandemonium": Tier(name="Pandemonium", host_limit=None, price_id=…),
}

# Stripe statuses that grant entitlement. `past_due` is deliberately included:
# Stripe's dunning runs for weeks and a card that failed this morning is not a
# reason to refuse a host this afternoon. Entitlement ends at `canceled` or
# `unpaid`, which is where Stripe has itself given up.
ENTITLING_STATUSES = frozenset({"active", "trialing", "past_due"})

async def entitlement(session, user) -> Entitlement:
    """host_limit (None = unlimited), tier, and where the number came from."""

async def host_count(session, user_id) -> int:
    """count(*) from hosts where owner_user_id = … — see the warning below."""

async def may_add_host(session, user) -> Decision:
    """The single question every enforcement point asks."""
```

Resolution order in `entitlement()`, first match wins:

1. `settings.billing_enabled` false → **unlimited**, tier `"free"`, reason
   `"billing_disabled"`. Self-hosted, and the only branch most deployments hit.
2. `user.host_limit_override is not None` → that value (0 = unlimited), reason
   `"comped"`.
3. A `Subscription` row whose `status` is in `ENTITLING_STATUSES` → its
   `host_limit`, reason `"subscription"`.
4. Otherwise → **1**, tier `"free"`, reason `"free"`.

> **Never count hosts via `host_key_claims`.** Deleting a host frees the slot
> immediately but deliberately *retains* the key claim
> (`routes/hosts.py:743-747`) so a machine can only ever return to the same
> account. A user who has deleted forty hosts still holds forty claims. The
> only correct count is `count(*) from hosts where owner_user_id = …` — there
> is no soft delete, no archived flag, and an offline host still occupies a
> slot, which is right, because an offline host is just a laptop that is shut.

### 4.5 Enforcement — two layers, and why

There is exactly **one** line in the entire server that brings a `Host` row into
existence: `routes/device.py:510`. Everything else updates a row that already
exists or authenticates against one. So the surface is small — but it needs two
checks, not one, and the reason is worth stating.

#### Layer 1 (primary) — `POST /api/auth/device/approve`, `routes/device.py:801`

This is where the paywall belongs. It runs `Depends(auth.verified_user)`, so
there is a real signed-in user, in a browser, who can act on the answer. That
dependency is *already documented* as the resource gate
(`auth.py:200-211`): *"Guards the step where an account first consumes
operator-funded resources (attaching a host, and with it TURN relay), not
sign-in itself."* Adding a host limit there is the intended reading of a seam
that already exists.

It returns a structured error the frontends render as an upgrade prompt:

```python
raise HTTPException(
    status_code=402,
    detail={"code": "host_limit", "tier": …, "host_limit": …, "host_count": …},
)
```

**402 is a deliberate departure.** Every existing capacity error in this
codebase is a `409` with a lowercase prose `detail` string
(`"too many host introductions"`, `"passkey capacity is exhausted"`). 402
Payment Required is the honest status for this one, and it lets the frontends
distinguish "you are out of room" from "you must pay to get more room" without
string-matching. It is also the first structured error body the server sends —
`web/src/lib/api.ts:50-65` already reads a top-level `code` and falls back to
`http_<status>`, so it lights up `ApiError.code` for free.

The check runs only when the key is **new** to this account. Re-approving a
machine that already has a `Host` row is not a new host and must never be
refused.

#### Layer 2 (backstop) — `POST /api/auth/device/poll`, before `device.py:509`

Approve and poll are decoupled: an approved `DeviceCode` lives 30 minutes
(`DEVICE_CODE_TTL_SECONDS`, `device.py:26`), so a user could approve several
codes while under the limit and let the daemons poll afterwards. The poll check
closes that.

It must sit **inside the `if host is None:` branch at `device.py:509`**, for
the reason in §1.2: a re-pair updates the existing row (`device.py:557-561`,
which deliberately preserves the user-assigned name) and must never be billed
as a new host.

It follows the `pin_limit` pattern exactly — that is an existing 32-per-host cap
which already travels the whole stack and is the template:

```python
if pin_count >= MAX_BROWSER_PINS_PER_HOST:      # device.py:587
    ... .values(status="pin_limit") ...          # persisted on the DeviceCode
    return {"error": "pin_limit"}                # returned to the daemon
```

So `host_limit` likewise: persist `DeviceCode.status = "host_limit"`, return
`{"error": "host_limit"}`, and add it to the terminal-status set at
`device.py:373` and to the `DevicePollPending.error` Literal at
`schemas.py:508`.

> **Why the poll check is a backstop and not the primary.** The Rust daemon's
> catch-all at `daemon/src/login.rs:333` renders an unrecognised code as a raw
> string: an un-updated daemon would print
> `device/poll returned error: host_limit`. Daemons auto-update but not
> instantly, and `install.sh` users on older builds exist. The nice copy has to
> come from layer 1.

#### The race, and the lock

Two daemons completing ceremonies concurrently would both read `count == 1` and
both insert, putting a free account on two hosts. The transaction already holds
a `HostKeyClaim` write fence (`device.py:265`) but that serialises only against
*the same key*, not against a different key being paired by the same user at the
same moment.

**Fix:** take a row lock on the owning account before counting, inside the
existing transaction:

```sql
SELECT id FROM users WHERE id = :user_id FOR NO KEY UPDATE
```

> **`FOR UPDATE` here deadlocks, and the race test is what found it.** By the
> time this runs, the same transaction has already inserted into
> `host_key_claims`, whose foreign key makes PostgreSQL hold `FOR KEY SHARE` on
> that very `users` row. `FOR UPDATE` conflicts with `FOR KEY SHARE`, so two
> daemons pairing at once each wait on the other's key share and both come out
> of `/device/poll` as a 500. `FOR NO KEY UPDATE` does not conflict with
> `FOR KEY SHARE` and still conflicts with itself, which is the mutual
> exclusion this lock exists for — and it is the honest lock, since nothing
> here modifies the row's key. Invisible on SQLite, which emits no locking
> clause at all and has one connection.

Proven by a test pair following the existing convention — a shared
`_assert_…(client)` body called from `test_file_sqlite_…(file_sqlite_client)`
and `test_postgresql_…(client)` (`tests/test_device.py:581`/`:594`). The
`file_sqlite_client` fixture exists precisely because in-memory SQLite shares
one connection and cannot exhibit a race.

#### What is NOT an enforcement point

`routes/install.py` serves the installer and binaries to anonymous callers and
never touches `Host`; `routes/hosts.py` lists, renames and deletes;
`ws/daemon.py` and `ws/host.py` operate on hosts that already exist. Putting a
check in any of them would either refuse an existing customer's running machine
or gate a public download behind an account. None of them gets one.

### 4.6 Stripe integration — `spawn_server/billing_stripe.py` + `routes/billing.py`

Architecture: **Stripe Checkout (hosted) to start a subscription, Stripe
Customer Portal for payment method, invoices and cancellation, and our own UI
for plan changes.** That last part is not the default recommendation and is
deliberate — see §5.6.

Pin `stripe` in `pyproject.toml` and pin the API version in code, so a Stripe
account-level version bump cannot change payload shapes under a running server.
The SDK is sync-first; confine every call behind one module with an injectable
client, matching the `httpx` idiom at `push.py:239-248` (`client=None` defaulting
to a real one) which is what makes those paths testable with no network.

> `web_push.py:29-32` records a decision to reject a library that dragged a
> second HTTP client into a server standardised on `httpx`. The `stripe` SDK
> ships its own. It earns its place by owning signature verification, API
> versioning and retry semantics that we would otherwise reimplement — but it
> stays behind `billing_stripe.py` and nothing else imports it.

#### Routes — `spawn_server/routes/billing.py`, prefix `/api/billing`

All of these return `404` when `settings.billing_enabled` is false, matching the
`require_admin` convention at `admin.py:35-40` — *"a non-admin has no business
learning that this surface exists on this deployment"*. A self-hosted install
should not have a discoverable billing API at all.

| Route | Auth | Does |
|---|---|---|
| `GET /api/billing/state` | `current_user` | tier, host_limit, host_count, status, renewal date, cancel_at_period_end, and the booleans the UI needs. The one read every surface uses. |
| `POST /api/billing/checkout` | `verified_user` | Creates a Checkout Session for a requested **tier name** and returns its URL. |
| `POST /api/billing/portal` | `current_user` | Creates a Customer Portal session, returns its URL. |
| `POST /api/billing/change-plan` | `verified_user` | Our own plan change. Runs the host-reconciliation precondition. §5.6. |
| `POST /api/billing/webhook` | **none** — signature | §4.6.2. |

**`POST /api/billing/checkout` — the security-critical details.**

- The request body carries a **tier name** (`"coven"`), never a price ID and
  never an amount. The server maps tier → price ID from its own config. A
  client that could name a price ID could name a $0 one.
- Bind the session to our user with **both** `client_reference_id=user.id` and
  `subscription_data.metadata.spawn_user_id=user.id`. `client_reference_id` is
  on the Session; the metadata rides onto the Subscription, so later
  `customer.subscription.*` events carry the binding without a Session lookup.
- Reuse the existing `stripe_customer_id` when the account has one, so a
  resubscribe does not create a second Customer and split the invoice history.
- Refuse when the account already has an entitling subscription — direct them
  to `change-plan` instead. Two active subscriptions on one account is a
  support incident and a double charge.
- Rate-limit per user via `rate_limit.enforce_identifier` (`rate_limit.py:98`),
  which exists for exactly this "trusted caller id rather than IP" case.
- `success_url` and `cancel_url` point back at the web app. **The success page
  grants nothing** — see §4.6.2.

#### 4.6.1 Webhook events

Subscribe to exactly these:

```
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
invoice.payment_action_required
invoice.finalization_failed
```

> **Do not subscribe to `invoice.created`.** If Stripe fails to get a success
> response to it, finalising every automatic-collection invoice is delayed for
> up to 72 hours. Subscribing converts a bug in our handler into a fleet-wide
> billing outage, for an event we have no use for.

`invoice.finalization_failed` is the one nobody remembers: the subscription
stays active but the invoice cannot be collected, so it is **silent revenue
loss with no user-visible symptom**. It alerts us, not the customer.

#### 4.6.2 The webhook handler — the rules

1. **Verify the signature against the raw bytes.** Read `await request.body()`.
   Do **not** declare a Pydantic body model on the handler and do **not** call
   `await request.json()` first — either re-serialises the payload and breaks
   the HMAC.

   *Verified for this codebase:* `SessionRenewalMiddleware` (`main.py:51`) is a
   pure ASGI **response** hook that wraps `send` only and never reads `receive`,
   and its docstring records that `BaseHTTPMiddleware` was rejected precisely
   because it interferes with bodies. So the raw body arrives intact and no
   middleware exemption is needed. **If a request-reading middleware is ever
   added, this route must be excluded from it.**

2. **Support a list of signing secrets, not one.** Rotation sends one `v1`
   signature per active secret in the same header for up to 24 hours. Trying
   each in turn makes rotation zero-downtime.

3. **Dedupe on `event.id`** with the `stripe_events` primary key: insert first,
   treat `IntegrityError` as "already applied", return 200. Do **not** dedupe on
   `created` — Stripe records it in whole seconds, distinct events share
   timestamps, and the docs name this as the wrong answer explicitly.

4. **Never apply a delta from the payload.** For every subscription-affecting
   event, re-fetch the Subscription from the API and write the whole current
   state. Stripe does not guarantee ordering; "go read the truth" is the only
   handler that is correct under out-of-order delivery. It also satisfies §3.4 —
   the tier is computed from the fetched `items.data[0].price.id` through our
   own map, never from anything the event asserted.

5. **Serialise per subscription.** Take a Postgres advisory lock keyed on the
   subscription id around fetch-then-write, so two concurrent handlers cannot
   interleave a stale fetch over a fresh one.

6. **Status codes decide retries:**
   - signature failure → **400** (it is not from Stripe, and a mis-rotated
     secret should alarm)
   - an event type we do not handle → **200**
   - DB or Stripe API unavailable → **500** (we want the retry)
   - a deterministic bug in our handler → **200** and alert ourselves; three
     days of retries against a `KeyError` delays nothing but our own fix.

7. **A 3xx is a failure to Stripe.** An nginx trailing-slash redirect on this
   path would silently break every event. Register the route at the exact URL
   given to Stripe and check `infra/nginx-spawnd.conf.example` does not
   normalise it.

8. **Be quick.** With `success_url` set, Checkout waits up to 10 seconds for our
   response before redirecting the customer — this handler is directly in the
   user's path.

9. **Entitlement is granted here and nowhere else.** Never from the
   `success_url` redirect: that is a URL the user can visit at will, and
   treating a browser arriving at it as proof of payment is the classic way to
   give away paid tiers.

#### 4.6.3 Reconciliation job

Webhooks can be missed — an endpoint outage longer than Stripe's three days of
retries, or a bug that returned 200 while doing nothing. A periodic job
re-fetches every non-free subscription and rewrites its state.

Follow the lifespan-owned polling loop already in the codebase —
`start_auto_update_checker()` / `stop_auto_update_checker()`
(`routes/hosts.py:414`, `:421`, started and stopped at `main.py:97`/`:102`).
No queue, no Celery; this server has neither and does not need one.

### 4.7 Email

The mail surface already exists (`spawn_server/mail.py`,
`spawn_server/email_templates.py`, admin visibility at
`routes/admin.py:177`). Billing adds:

| Trigger | Mail |
|---|---|
| Subscription started | Confirmation: tier, price, renewal date, cancellation instructions. Required by EU/UK distance-selling rules; Stripe's own receipt does not cover the pre-contract disclosure. |
| `invoice.payment_failed` | "We couldn't take payment" + a portal link to update the card. Not a revocation notice — dunning is still running. |
| `invoice.payment_action_required` | The hosted invoice URL so they can complete 3-D Secure. |
| Plan changed | What changed, when it takes effect. |
| Subscription ended | What their limit is now, and what happens to their hosts. |
| **Host limit reached on mobile** | §6.3 — this one exists because of an App Store rule, and it is the mobile conversion path. |

Every one of these is off when `billing_enabled` is false.

### 4.8 Comped accounts

`User.host_limit_override`, nullable. `NULL` = no override, `0` = unlimited, any
other integer = that many hosts. It outranks any subscription (§4.4 order), so a
comped account with a lapsed card is unaffected.

Set from a new admin route beside the existing user list:

```
PATCH /api/admin/users/{user_id}   { "host_limit_override": 0 | int | null }
```

Guarded by `require_admin`, which 404s rather than 403s for non-admins.
`AdminUserOut` (`routes/admin.py:98`) already carries `host_count`; it gains
`host_limit_override` and the resolved effective limit. The admin UI at
`web/src/app/admin` gets the control.

This is how internal accounts never pay, and how you comp a customer without
touching Stripe.

### 4.9 Account deletion — a real money bug if missed

`POST /api/auth/account/delete` (`routes/auth.py:184`) deletes the user. A
`Subscription` row FK'd `ondelete="CASCADE"` would **vanish locally while Stripe
kept billing the card**.

That function already does exactly this class of work by hand — it explicitly
deletes `HostKeyClaim` rows at `auth.py:237` because their FK is `RESTRICT` and
the docstring explains why. Billing gets the same treatment: cancel the Stripe
subscription (and detach or delete the Customer) **before** the user row goes,
in the same function, with a comment saying why it cannot be left to the
cascade.

If the Stripe call fails, the deletion must still proceed — a user's right to
delete their account cannot be blocked by our payment processor being down — but
it must be recorded loudly enough that someone cancels it by hand.

### 4.10 What the server advertises

**`GET /api/auth/config`** (`routes/auth_config.py`, `AuthConfigOut` at
`schemas.py:383`) gains a billing block. This endpoint is unauthenticated, is
already read by both frontends and onboarding, and its docstring states the
governing rule: the advertised flag mirrors the exact condition the server
enforces.

```python
class BillingConfigOut(BaseModel):
    enabled: bool = False              # false ⇒ frontends render no billing UI at all
    free_host_limit: int = 1
    tiers: list[BillingTierOut] = []   # name, price, host_limit, for the pricing page
    # Whether the mobile apps may show an off-platform upgrade link. Off at
    # launch; see §6.1. Server-driven so it can be turned on or off without an
    # App Store submission.
    mobile_upgrade_link: bool = False
```

**`GET /api/profile`** (`routes/profile.py:32`, `ProfileOut` at
`schemas.py:1022`) gains the per-account state — tier, `host_limit`,
`host_count`, `over_limit`. It already loads the account's hosts
(`profile.py:40-50`) and is documented as *"One request backs the whole profile
dialog"*, so this costs no extra round trip on any surface.

> There is no `/api/capabilities`. `routes/capabilities.py` is about agent
> skills despite the name; do not put billing there.

---

## 5. Web — `web/`

### 5.1 `/pricing`

A **server component** with `export const metadata`, wearing pressroom chrome
(`Masthead` + `Colophon`). `/security` (`src/app/security/page.tsx`) is the
exact template — the only other public server-rendered marketing page.

- `Masthead`'s `current` prop is typed `"security" | "download"`
  (`src/components/brand/press.tsx:134`) and widens to include `"pricing"`.
- Add the link to the masthead's left zone (`press.tsx:151-166`) and to the
  `Colophon` (`press.tsx:209-235`).
- **Both are wrapped in `inShell` guards.** Inside the desktop window every
  masthead and colophon link is hidden, because that window has no address bar
  and anything leading to the marketing site is a dead end
  (`web/CLAUDE.md:69-79`). A pricing link inherits that automatically — which is
  correct, and it is why desktop needs its own upgrade affordance (§7).

**Content.** Four columns: Free, Coven, the Legion plan, Pandemonium. Each shows
price, host count, and what a host is. It must state plainly:

- billing is monthly in USD, renewing until cancelled;
- cancel any time, from Settings → Subscription;
- **a host is a registration, not a machine** (§1.2 rule 1);
- what happens at the limit (you choose which hosts to keep);
- self-hosting is free and unlimited, with a link to `/download` — this is not
  a giveaway, it is already true and `docs/TRUST.md` names self-hosting as the
  escape hatch for anyone the retained metadata bothers.

Plus links to `/terms` and `/privacy`, and a tax line consistent with the §2.4
decision.

**Design.** The four-up "Where it can run" grid on `/download` is the direct
structural analogue; `Rite` on the lander is the closest tier-like layout. Mark
the recommended tier with the `bg-plate` flood coat or an `Eyebrow` in hellfire
— **never a red button**. Recommended tier gets `CTA_SLAB`, the others
`CTA_GHOST`/`CTA_QUIET`. `RegistrationMarks` on the hero. Flavoured heading,
standard button verbs (`Upgrade`, not `Ascend`).

### 5.2 `/terms` and `/privacy`

Neither exists today; the `Colophon` currently offers only Security, Install and
Log in. Both are **blocking** (§2.1) and both are needed three times over:
Stripe activation, App Store Connect submission, and Google Play listing.

> **This is worse than a billing blocker, and it is not caused by billing.**
> There is no privacy policy anywhere in the repo — no `/privacy` route, no
> privacy link in the mobile About screen, no matching file repo-wide. Apple
> 5.1.1(i) requires the link **in App Store Connect metadata *and* inside the
> app**. So the mobile app **cannot be submitted to either store today**,
> billing or no billing. This outranks everything else in this document.

Three further obligations that are already overdue and are not optional:

1. **A privacy link inside the mobile app**, not only on the website — Apple
   5.1.1(i). The About screen is the place.
2. **A web account-deletion request URL**, reachable without installing the app.
   Google requires this separately from in-app deletion. In-app deletion already
   exists (`account-panel.tsx` → `deleteAccount`, with a test), so Apple 5.1.1(v)
   is satisfied; Google's web route is not.
3. **The EU withdrawal button** — Consumer Rights Directive Art 11a, mandatory
   since **19 June 2026**. It binds non-EU traders selling to EU consumers and
   carries penalties up to 4% of turnover. Any page where a consumer can enter a
   subscription needs it, so it lands with `/pricing` and Checkout.

> **A live risk this feature creates.** The mobile About screen already has a
> **tappable** `spawnd.dev/download` link. That is harmless today. The moment
> that site grows a `/pricing` page, a reviewer can read an in-app tappable link
> to a site selling subscriptions as a 3.1.1 steering violation. Either make that
> link non-tappable text, point it at a path with no route to pricing, or remove
> it — **decide this in the same commit that ships `/pricing`.**

Same pressroom server-component shape as `/security`. Content needs your
sign-off; the plan provides the structure and the legally-required elements:

**`/terms`** — who the contract is with; what the service is; subscription
price, period and renewal; how to cancel and when it takes effect; refund
position; the EU/UK 14-day withdrawal right and how the waiver is handled;
acceptable use; liability; termination; governing law.

**`/privacy`** — this one must be *accurate*, and `docs/TRUST.md` already does
the hard work: it maintains an honest inventory of exactly what the server holds
and stakes the careful claim that the server *cannot* see protected content
(cryptographic) rather than merely does not look (policy). The privacy policy
must not overclaim beyond that. It has to cover the metadata inventory, the new
billing data (§3.6), Stripe as a processor, email, push tokens, retention, and
deletion — with `POST /api/auth/account/delete` named as the mechanism.

These also feed the App Store **privacy nutrition label**, whose answers must
match this page.

### 5.3 Settings → Subscription

The settings modal is a modal over whatever route you are on, **never a route**,
driven by a module-singleton store so that opening it never navigates
(`settings-dialog-store.ts:5-9`). A new tab is a seven-file change:

1. `src/components/settings/settings-dialog-store.ts:14-21` — add
   `"subscription"` to `SettingsTab`
2. `src/components/settings/SettingsDialog.tsx:41-53` — a `TABS` row
   (`CreditCard` from lucide)
3. `SettingsDialog.tsx:109-115` — `{tab === "subscription" && <SubscriptionPanel />}`
4. `SettingsDialog.tsx:62-64` — the `sr-only` `DialogDescription` **enumerates
   the sections** and must be updated, or the modal lies to a screen reader
5. new `src/components/settings/SubscriptionPanel.tsx`
6. `tests/e2e/app-mocks.ts:1848-1858` — `SETTINGS_TAB_LABELS`
7. `tests/e2e/settings-modal.spec.ts:3-22` — the spec is literally named
   **"all seven settings tabs open"** and iterates a hard-coded array. It
   becomes eight. Renaming that test is part of the change.

**The tab is hidden entirely when `billing.enabled` is false** — a self-hoster
sees seven tabs, exactly as today.

**Panel contents:** current tier, hosts used of limit, renewal or cancellation
date, and the actions — `Change plan`, `Manage billing` (portal), and on Free,
`Upgrade`. Plain `<Button>`, `text-brand-accent` for the accent.

> **The poster face is banned in app chrome.** `legion-parts.tsx:247-249`
> records that Rowdies is deliberately confined to marketing surfaces. The
> panel uses weight and tabular figures for emphasis, not `poster.className`.

### 5.4 The hard block — one component, three routes

There is exactly **one** component that performs the possession ceremony:
`src/components/hosts/connect-host.tsx` (1276 L). `/device`, `/legion`'s Add-a-
machine dialog and `/onboarding` all mount it. **Blocking there covers all
three at once**, and the ~23 links and empty states that lead to it need no
changes — making all of them limit-aware would be 23 edits for one message.

Two pieces:

1. **`src/lib/pairing-errors.ts`** — add `"host_limit"` to `PairingFailureCode`
   (`:3-8`), to `FAILURE_CODES` (`:24-30`), and to `PAIRING_FAILURE_COPY`
   (`:10-22`). `pairingFailureCode()` already digs a code out of `error.code`,
   `error.message`, `error.detail`, and `detail.code`/`.error`/`.message`
   (`:48-62`), so it works whether the code arrives as our 402 structured body
   or as the poll's `{"error": …}`. Its test file gains the case.
2. **A CTA, which the default failure path cannot render.** `PairingFailure`
   (`connect-host.tsx:586-600`) renders **plain text only**. An upgrade prompt
   needs a button, so add a dedicated branch above the `if (failure)` early
   return at `:1069`. The shape to copy is the terminal-refusal branch at
   `:1010-1033` (`data-testid="possess-refusal"`), which already renders a
   `Button`.

The prompt says what the limit is, what plan they are on, and offers `Upgrade`
(to `/pricing` or straight to Checkout) and `Manage hosts`.

### 5.5 `/legion` — soft state only

`src/app/legion/page.tsx` already polls hosts every 15s (`:46-51`). At capacity:

- the header **Add a machine** button (`:70-74`) keeps working but shows an
  at-capacity affordance rather than being disabled — a disabled button with no
  explanation is worse than a click that explains itself;
- the empty rack slot (`:122`) and empty state (`:141`);
- the fleet totals strip (`:92-101`) is the natural place for "3 of 3 hosts".

### 5.6 Changing plans, and choosing which hosts to keep

**Plan switching is disabled in the Stripe Customer Portal on purpose** (§2.2
step 5). The portal will happily let someone downgrade and never consults us,
which would leave an account over its limit with no chance to choose. Owning the
plan-change UI is what makes your rule — *"allow them to downgrade, they just
have to select the ones they want to keep"* — implementable.

**Upgrades** apply immediately with a proration. The user pays the difference and
gets the higher limit at once.

**Downgrades** run this sequence:

1. The user picks a smaller tier in Settings → Subscription.
2. If their current host count exceeds the new tier's limit, we show the
   **selection step**: every host with its name, OS and last-seen, and a
   requirement to choose exactly `new_limit` of them to keep.
3. On confirm, the unselected hosts are released through the existing
   `DELETE /api/hosts/{id}` path (`routes/hosts.py:707`). That path already
   frees the slot synchronously, retains the `HostKeyClaim` so the machine can
   only ever return to this account, and closes the live daemon socket with
   `4001 "host revoked"` — behaviour the daemon already handles correctly.
4. Only then do we call Stripe to change the plan.

Doing the release *before* the Stripe call means a failed payment leaves them on
the old plan with fewer hosts — recoverable and honest — rather than on a
cheaper plan while still over its limit.

**Downgrades apply immediately, not at period end.** Deferring them looks kinder
and is a trap: scheduling a decrease creates a subscription schedule, and
*"customers can't update or cancel subscriptions that currently have an update
scheduled with a subscription schedule"* — so a user who downgrades would be
locked out of **all** self-service changes, including cancelling, for up to a
month. That is a support incident generator and a consumer-law problem, and it
buys nothing here: the host-selection step in step 2 already resolves the
over-limit question at the moment of the change, so there is no deferral to
gain from.

> Verify in the sandbox before relying on either behaviour: confirm whether the
> portal's `schedule_at_period_end` actually materialises a schedule object, and
> confirm that an immediate downgrade leaves the subscription fully
> self-serviceable. This is a ten-minute experiment and it governs the flow.

**Detecting a downgrade: diff against our own stored `host_limit`, never against
the event's `previous_attributes`.** That field is real and does carry the old
items array, but it is **absent on `customer.subscription.deleted`** — and a
cancellation is a downgrade — and absent when the reconciliation job (§4.6.3)
finds drift. Two detection paths that can disagree is how an account silently
keeps a limit it no longer pays for. Comparing the freshly-fetched limit to the
one in our row is idempotent, ordering-independent, and identical on every path.
Exactly one event fires on an immediate portal downgrade:
`customer.subscription.updated`.

### 5.7 When the account is over its limit anyway

Three paths reach this state without passing through §5.6: cancellation via the
portal, a subscription that lapses to `unpaid`, and an admin removing an
override.

The account then holds more hosts than its limit, and **the user must choose
which to keep — or keep none.** The choice is mandatory, not an invitation.

- `/api/profile` reports `over_limit: true`, the new limit, and the current
  count, so every client can act on it.
- On next load, **web and desktop present a reconciliation modal that cannot be
  dismissed until a choice is made.** It lists every host with name, OS and last
  seen, and requires selecting **at most** the new limit — selecting zero is a
  valid answer and must be offered plainly, not buried.
- On confirm, the unselected hosts are released through the ordinary
  `DELETE /api/hosts/{id}` path (`routes/hosts.py:707`), which frees each slot
  synchronously, retains the `HostKeyClaim` so those machines can only ever
  return to this account, and closes each live daemon socket with
  `4001 "host revoked"` — behaviour the daemon already handles.
- Until they choose, existing hosts keep running and **no new host can be
  added** (§4.5 enforces that regardless of UI). Nothing is suspended and
  nothing is deleted without the user's explicit selection.
- **Mobile shows this too, and must.** Releasing hosts is host management, not
  commerce — there is no price, no venue and no purchase verb in it, so it is
  fully compliant and the phone is a legitimate place to resolve it. A user
  whose only device is a phone must not be stuck.
- An email accompanies it, explaining the state and that the machines keep
  running until they decide.

The forced choice is what closes the revenue hole: a cancelled Pandemonium
account cannot sit on 50 hosts, because the next time anyone opens the app they
must reduce to the free limit or release everything. And because the release
only ever happens on an explicit human selection, the server never deletes
someone's host on a billing signal.

### 5.8 Where billing must NOT appear

`/onboarding` — **the first host is free on every tier**, so the onboarding
ceremony must never show a paywall. A new user hitting a billing wall before
their first machine is online would be the worst possible first impression, and
the free tier is specifically sized so it cannot happen.

Also excluded: `trust-ux-demo` (a design demo, not product), `PossessHost`, and
`AccessScreen`.

---

## 6. Mobile — `mobile/`

### 6.1 The posture, and why

The mobile apps **never sell anything**. No price, no buy button, no link to a
purchase page, no QR code or copy-to-clipboard containing a checkout URL. They
show subscription *status*, and at the limit they say what the limit is and what
the user can do inside the app.

This is more conservative than Apple's current rules require, and the reason is
not "Apple forbids it":

- Guideline 3.1.1(a) currently permits link-outs **on the US storefront**, and
  3.1.3's anti-steering sentence carves the US out expressly.
- But that permission is unstable: the Supreme Court granted certiorari on
  30 June 2026, and Apple filed a proposed 15% link-out commission on
  14 August 2026.
- It is US-storefront-only, and the rule keys on the **storefront**, not device
  locale — detecting it correctly needs a native StoreKit `Storefront.current`
  call. `mobile/` has no such module, and adding one forces a custom dev build,
  ending Expo Go testing.
- The exemption that looks tailor-made is a trap. 3.1.3(f) covers *"Free apps
  acting as a stand-alone companion to a paid web based tool (i.e. VoIP, Cloud
  Storage, Email Services, Web Hosting)"* — reviewers read that list as
  exhaustive, and a developer tool is not on it. 3.1.3(b)'s multiplatform
  allowance carries the proviso *"provided those items are also available as
  in-app purchases within the app"*, which is exactly what we are not doing.

**So the decision is server-driven.** `billing.mobile_upgrade_link` (§4.10) is
`false` at launch. If the law settles, flipping one env var turns the link on
with no App Store resubmission — and flipping it back turns it off the same day,
which matters more, because a binary already in the store cannot be recalled.

> **As built, the flag is advertised and parsed, and nothing consults it,
> because no upgrade affordance ships at all.** That is a deliberate departure
> from the paragraph above and it is the stronger reading of its own argument.
> The half that matters is being able to turn the link *off* the same day; with
> no link in the binary there is nothing to turn off, and a dormant purchase
> path sitting inside a shipped app buys nothing until the day it is wanted.
> This is an Expo app, so adding the affordance is a JavaScript change that
> reaches phones through `eas update` — still no App Store resubmission, which
> is the requirement the flag existed to satisfy. The flag stays in
> `/api/auth/config` and stays parsed so the contract is ready; the day the law
> settles, the affordance and the flag land together.
>
> `BillingConfigSchema` in `mobile/` also **omits `tiers` deliberately**. Zod
> strips what it does not name, so the catalogue — and therefore every price —
> never enters the app's memory at all. The bright line below is then a
> property of the data model rather than a rule someone has to keep.

**The bright line, in code review terms:** no string in `mobile/` contains a
price, and no `Linking.openURL` / `expo-web-browser` call in a billing context
targets a checkout or pricing URL, while `mobile_upgrade_link` is false.

> **A server string can breach anti-steering with no mobile code involved.**
> `mobile/src/components/trust/trust-failure-state.tsx:140-152` renders
> `ApiError.message` **verbatim**. So a server-side billing error reading
> *"Upgrade at spawnd.dev"* would appear inside the iOS app, with no string in
> `mobile/` containing it and no mobile test catching it.
>
> **Therefore: no error message the server can emit on a billing path may
> contain a URL, a price, or a purchase verb.** The server sends a stable
> machine code (`host_limit`) plus neutral prose; each client owns its own copy.
> This is a server-side constraint enforced for a mobile-store reason, which is
> exactly the kind of rule that gets broken later by someone improving an error
> message — so it belongs in the test suite (§9.1), not just here.

**Apple polices the verb; Google polices the link.** Reviewer guidance is that a
*non-tappable* "Go to our website" still fails, and that the fix is to phrase it
declaratively — while Google's own published example of **approved** copy is the
imperative *"Go to our website to upgrade your subscription to Premium"*. So
write to Apple's rule and Google is covered for free:

- ✅ "Billing is managed on the web." — declarative, no verb aimed at the user
- ❌ "Manage your plan on the web." — imperative, fails Apple's stated test

This is why §6.4's copy reads the way it does. Do not "improve" it into an
instruction.

There is already a precedent for words-without-a-link in this codebase: the App
Store URL is deliberately null in the download copy. Follow it.

**Android is treated identically.** Google Play is materially more permissive
now, but shipping one behaviour on both platforms is far cheaper than
maintaining two, and the conversion difference on a $5 product does not pay for
the divergence. The same server flag governs both.

### 6.2 Where the state lives

Put the subscription summary on the shared **`UserOut`** schema, so it arrives
through `/api/me`, `/api/profile` and the token responses at once. Mobile then
reads it via the existing `useMeQuery()` / `useMeSettingsQuery()`, both keyed
`qk.me()` — a single cache entry that already feeds Settings, the Legion header,
the profile page and the pairing flow. This is exactly how `user.is_admin`
already gates the Admin row (`settings-root.tsx:72`), so there is no new
plumbing.

> **Two hazards, both load-bearing.**
>
> 1. **`/api/me` gates app launch.** `useAuthBootstrap` returns
>    `{ status: "loading" }` while `meQuery.data === undefined`
>    (`auth-gate.tsx:236-244`) and `AuthGate` holds a full-screen overlay until
>    it resolves. A tightened schema here breaks **launch**, not a screen. Every
>    new field must be optional or defaulted.
> 2. **Login and OAuth seed the me-cache from the token response**
>    (`seedMe`, `data/queries/auth.ts:19-21`, called at `:53`, `:65`, `:97`,
>    `:116`, `:135`). If the server returns subscription data on `/api/me` but
>    not on `/api/auth/login`, a stale seeded value survives until the first
>    refetch. Add the field to `UserOut` itself so both carry it.

Same rule for the capability flag in `src/data/api/schemas/auth.ts:50-54`:

```ts
billing_enabled: z.boolean().default(false),
```

The `.default(false)` is load-bearing — a self-hosted server that omits the
field must not trip `schema_mismatch` and brick the launch path.

### 6.3 The host-limit moment

All 21 add-a-host affordances in mobile funnel into **one route** —
`/onboarding/host`, which is a one-line re-export of
`src/app/onboarding/device.tsx` → `PairingScreen` → `HostPairingStep`. And
critically, **mobile has no host-creation API call at all**: the phone only
*approves* a ceremony a daemon started. `src/data/api/endpoints/hosts.ts` has no
`createHost`.

So the limit message lands in exactly two places:

1. **`HostPairingStep`** (`src/components/onboarding/host-pairing-step.tsx:254-295`)
   — when the approve call returns our 402 `host_limit`.
2. **`InstallInstructions`** (`src/components/onboarding/install-instructions.tsx:76-185`)
   — the best pre-empt, shown *before* someone walks to another machine and
   installs a daemon that will be refused.

Compliant copy, shipped worldwide on both platforms:

> **Host limit reached**
> Your plan includes 3 hosts. Disconnect one to connect another.

No price, no venue, no verb pointed off-platform — pure account state plus an
action the user can take in the app. It stays compliant whatever the courts do.

**And the server sends an email.** This is the mobile conversion path, and it is
explicitly blessed by the guideline itself, in the 3.1.3 preamble:

> *"Developers can send communications outside of the app to their user base
> about purchasing methods other than in-app purchase."*

The email can carry the price, the tier comparison and a direct Checkout link,
because it is outside the app. That converts a policy problem into a lifecycle-
email problem. The app must not *say* it is sending one in a way that reads as
steering; it just sends.

### 6.4 Settings → Subscription (read-only)

A new panel in the registry at
`src/components/settings/settings-inventory.ts:22-132` — a `readonly` array
typed `as const satisfies readonly SettingsPanelDefinition[]`, so the new entry
needs `key`, `label`, `description`, `icon`, `route`, and `controls`. Adding a
route also means:

- a screen at `src/app/(drawer)/(tabs)/settings/subscription.tsx`;
- an entry in `APP_ROUTE_MAP` (`src/app/(drawer)/_layout.tsx:23-49`) — a test
  asserts every documented URL is present
  (`src/app/__tests__/route-map.test.ts:7-38`);
- the `controls` array kept true, since `panel-behavior.test.tsx` reads it.

Contents, and nothing more:

> **Plan**
> Coven · 3 of 3 hosts in use
> Renews 24 September 2026
> Billing is managed on the web.

The last line is passive, names no venue, carries no verb aimed at the user, and
no price. It reads as an explanation for the absence of a button rather than an
inducement to press one — a distinction reviewers do recognise. Tier name,
capacity and renewal date are all account state describing something already
purchased, which is precisely what 3.1.3(b)'s opening clause permits.

The whole panel is hidden when `billing_enabled` is false.

### 6.5 App Review preparation

- Provide a demo account **with live hosts already attached**, and a reviewer
  note explaining that the app is a companion client to a web-based service,
  that no purchase or account creation of any kind happens in the app, and that
  everything shown is access to a subscription acquired on the web.
- Have a 3.1.1 appeal drafted before the first submission.
- In-app account deletion is already required and already present
  (`mobile/src/components/settings/account-panel.tsx` →
  `POST /api/auth/account/delete`), so that box is ticked.
- The privacy nutrition label answers must match `/privacy` (§5.2).

---

## 7. Desktop — `desktop/`

### 7.1 One window, two faces — and only one of them is ours to change

`desktop/src-tauri/src/window.rs:1-16` describes it: until the machine is
possessed the window is **the wizard** (bundled vanilla TS in
`desktop/src/main.ts`, no framework — `desktop/CLAUDE.md:162-163` forbids
adding one); afterwards it navigates to the **product**, which is the real
`web/` Next.js app loaded from the chosen server.

**The product face has zero IPC.** `capabilities/default.json:4-5` scopes the
capability to the `main` window and names no remote URL. So all the billing UI
on the product face is simply `web/`'s (§5) reaching the server by ordinary
fetch — no Tauri work at all.

**Distribution is direct** — Developer ID + notarisation + stapled DMG with a
self-hosted updater on macOS, per-user NSIS with Azure Key Vault Authenticode on
Windows. Not the Mac App Store, not the Microsoft Store. **So desktop has no
platform billing constraints whatsoever**: it may show prices, show a Buy
button, and open Checkout, worldwide, with no entitlement.

### 7.2 The wizard's host gate — the one place that must change

The desktop app possesses exactly **one machine: itself**. There is no "add
another host" UI. But the first-run host gate has no button at all
(`main.ts:1360-1365`):

```ts
  setScreen("host");
  // The gate has nothing to ask. This app holds the account, it runs the
  // install itself … a button here was a question with one answer.
  if (!hostRunStarted) void startPossession();
```

Reaching the host gate *is* the possession. **A user at their limit would
otherwise watch a spinner, then a daemon download, then an opaque failure.** So
the gate must check entitlement *before* `startPossession()` and render an
upgrade panel instead.

Surfaces that reach possession, all of which route through `startPossession()`:

| # | Surface | `main.ts` | Limit-gated? |
|---|---|---|---|
| 1 | First-run host gate (auto) | `:1360-1365` | **Yes — primary** |
| 2 | `startPossession()` | `:1484-1496` | via #1 |
| 3 | "Try again" / "Start over" | `:1122-1127` | **Yes** |
| 4 | Repair → "2 · Verified reinstall" | `:989` | **No** — existing host |
| 5 | "Add another account" (`--new-account`) | `:1128-1130` | **Yes** — this creates a *second* `Host` row for the same machine |
| 6 | Terminal one-liner panel | `:857-865` | **Yes** — hands the user a command that fails much later, in a terminal |
| 7 | Repair → "1 · Re-run spawnd possess" | `:988`, `:1164-1168` | **No** — existing host |
| 8 | Tray → Repair/Settings/Update/Quit | `tray.rs:79-93` | No possession action; routes to #4/#7 |

#5 deserves attention: it is the one desktop affordance that genuinely
increases the host count, and its copy currently reads as a neutral
convenience.

### 7.3 Plumbing

The wizard never fetches from JS — the webview CSP forbids remote connects
entirely (`tauri.conf.json:17`) and every network call is a Rust
`#[tauri::command]` using `reqwest` through `src-tauri/src/api.rs`. So billing
state needs a new command alongside the existing 30-odd
(`lib.rs:366-396`):

```
subscription_state   -> tier, host_limit, host_count, may_add_host
open_upgrade         -> opens the system browser at the pricing/checkout URL
```

Opening an external URL is **already solved and needs no capability change** —
the report confirms the existing mechanism and that the capability set already
permits it. Open the **system browser, not an embedded webview**: an embedded
webview breaks password managers, complicates 3-D Secure, and degrades Stripe's
fraud signals for no benefit.

Neither macOS notarisation/Gatekeeper nor Windows SmartScreen has any billing
implication — Gatekeeper checks signature and notarisation, never behaviour or
network destinations, and SmartScreen scores binary reputation and never
inspects URLs the app later opens.

### 7.4 Settings

Desktop has its own `settingsView` (`main.ts:962`) with an obvious slot for a
plan line: tier, hosts used of limit, and a `Manage plan` button that opens the
browser. Desktop may show the price.

---

## 8. Daemon — `daemon/`

### 8.1 Almost nothing changes, and that is the design

Because the limit is enforced at possession time and existing hosts are never
suspended, **the daemon needs no new WebSocket close code and no new connection
handling**. Hosts released during a downgrade go through the ordinary
`DELETE /api/hosts/{id}` path, which already closes the socket with
`4001 "host revoked"` — behaviour the daemon handles correctly today.

> **This avoided a genuinely dangerous change.** Reusing `4002` for a quota
> refusal would map to `CloseDisposition::ClientBug`, which terminates
> `spawnd run` — and the service then **crash-loops under launchd / Task
> Scheduler**, the exact failure mode recorded in the
> `spawn-daemon-service-crashloop-debug` notes. Any unmapped code falls to
> `_ => Reconnect` and retries silently for ever. Both are worse than not
> needing a code at all.

### 8.2 The one change: the poll refusal

`daemon/src/login.rs` matches poll error codes and prints copy for each; the
catch-all at `:333` renders anything unknown as
`device/poll returned error: <code>`. Add a `host_limit` arm with honest copy.

Per `daemon/CLAUDE.md:186-198` — *"Offer the action, do not print the command"* —
where there is a terminal, the daemon offers a `prompt_choice` row rather than a
sentence ending in something to copy. At the limit there is genuinely nothing
the daemon can do locally, so the honest content is: what the limit is, that the
machine was not registered, and that the plan is changed on the web. This is a
terminal on the user's own machine, not an App Store binary, so naming the URL
is fine here.

Old daemons keep printing the raw string until they auto-update. That is
acceptable degradation and is precisely why the primary gate is at
`/device/approve`, in the browser (§4.5).

### 8.3 The install script

`GET /install.sh` and `/install.ps1` (`routes/install.py`) are anonymous — the
script has no account context and cannot know a limit. It stays that way: the
earliest honest place to refuse is the possession ceremony, which is where the
account first appears. Gating the download would break the public install path
for no gain, since installing a daemon is not the same act as registering a
host.

---

## 9. Tests

### 9.1 Server — `server/tests/`

Two new files, matching the `test_<module>.py` convention.

**`tests/test_billing.py`** — entitlement and enforcement, no Stripe:

- the resolution order in §4.4, all four branches;
- `billing_enabled=false` ⇒ unlimited, and **no billing routes exist** (404);
- `host_limit_override` outranks a subscription, including `0` = unlimited;
- the free limit refuses a second host at `/device/approve` with a 402 whose
  body carries `code: "host_limit"`;
- the poll backstop refuses when approve was somehow bypassed;
- **re-pairing an existing host is never refused**, at either layer, at any
  limit — the regression that would strand people from their own machines;
- deleting a host frees a slot synchronously;
- `count(*)` ignores `host_key_claims` entirely (create, delete, re-count).

> Tests must drive the **real ceremony**, not the ORM. About twenty existing
> tests construct `Host(...)` directly (`test_hosts.py:113` and friends), which
> bypasses every route and every limit — so none of them break, and none of them
> prove anything about this feature. Use the `_pair()` helper shape at
> `tests/test_device.py:244` (start → pending → approve → poll), with
> `_mark_possession_verified()` (`:119`) as the shortcut past real Ed25519
> proofs.

**The race test** follows the established convention exactly — a shared
`async def _assert_…(client)` body called from
`test_file_sqlite_…(file_sqlite_client)` and `test_postgresql_…(client)`, as at
`test_device.py:581`/`:594`. The `file_sqlite_client` fixture
(`conftest.py:101`) exists precisely because in-memory SQLite shares one
connection and cannot exhibit the race.

**`tests/test_stripe_webhook.py`** — no network:

- a locally-constructed valid signature is accepted; a bad one is **400**;
- a replayed `event.id` is a no-op and still **200**;
- out-of-order delivery converges, because the handler re-fetches rather than
  applying a delta;
- an unhandled event type returns **200**;
- a Stripe API outage returns **500** so Stripe retries;
- the entitlement change lands on the right user via `client_reference_id` /
  subscription metadata;
- **the `success_url` redirect grants nothing** — visiting it repeatedly never
  upgrades anyone.

Note `conftest.py:14-27` sets env **before app import** and `SPAWN_PUBLIC_URL`
is a hard assignment rather than `setdefault`. Billing tests must
`monkeypatch.setenv` then `get_settings.cache_clear()`, as `test_config.py`
already does. The schema comes from `Base.metadata.create_all`, not Alembic, so
migration `0070` needs its own coverage in the `test_migration_00NN_*.py` style.

### 9.2 Web

`npx bun` — bun is not on PATH directly on this machine.

- unit: `pairing-errors.test.ts` gains the `host_limit` case, including the
  detail-object shape our 402 sends;
- e2e (`tests/e2e/`, mocked via `app-mocks.ts`): the settings tab list grows to
  eight and **`settings-modal.spec.ts` is literally named "all seven settings
  tabs open"** — rename it;
- new specs: the pricing page renders four tiers; the limit block appears at the
  ceremony with a working CTA; the plan-change host-selection step; and a
  self-hosted config (`billing.enabled: false`) shows **no** Subscription tab
  and **no** pricing link anywhere.

Per project notes, e2e in a shared tree can 404 from concurrent edits — snapshot
`web/` to a temp dir for a clean run.

### 9.3 Mobile

`npm run ci` (typecheck + lint + jest).

- the Subscription panel renders status and **contains no price string** — assert
  this explicitly, it is the compliance bright line;
- no `Linking.openURL` to a billing URL while `mobile_upgrade_link` is false;
- the limit copy renders at `HostPairingStep` and `InstallInstructions`;
- `billing_enabled: false` hides the panel;
- `route-map.test.ts` and `panel-behavior.test.tsx` updated for the new route
  and its `controls` array;
- **a `/api/me` response with no billing fields still launches the app** — the
  `.default(false)` / optional-field guarantee from §6.2.

RNTL renders are async: `await` render/renderHook/act. No type aliases inside
`jest.mock` factories. Full runs flake in a shared tree — re-run a suite alone
before blaming a change.

### 9.4 Stripe, end to end

`stripe listen --forward-to localhost:8000/api/billing/webhook` prints a local
`whsec_`; `stripe trigger <event>` fires individual events. **Test clocks**
(Dashboard: "Simulations") are the only honest way to exercise renewal, dunning
and period-end downgrades without waiting a month. Use `pm_card_chargeCustomerFail`
for the dunning path.

### 9.5 The guards

`scripts/test-all.sh` runs `scripts/check-claude-md.sh`, which fails when a
tracked directory is not named in the owning `CLAUDE.md`. This feature adds no
directories, but `server/CLAUDE.md` must still gain `billing` and
`billing_stripe` in its module list and `routes/billing.py` in its routes list,
in the same commit, per the root `CLAUDE.md`.

---

## 10. Release sequence

`docs/RELEASE.md` is the authority; read it in full before deploying. The
ordering below exists because the wire and the schema move independently.

1. **Migration `0070` first.** Additive only, so old code tolerates it and it
   runs while the previous processes drain. Confirm `alembic heads` is a single
   head after any merge.
2. **Server with `SPAWN_BILLING_ENABLED=false`.** Everything ships dark: the
   routes 404, the limit is absent, the config advertises `enabled: false`, and
   both frontends render exactly what they render today. This is a no-op deploy
   that can be verified in production before any money is involved.
3. **`web/` and `mobile/` together**, in the same commit as any shared-endpoint
   change — the root `CLAUDE.md` requires it, and `/api/auth/config` and
   `UserOut` are both shared. Still dark.
4. **Desktop** — its product face is `web/`, so most of it arrives with step 3;
   the wizard gate needs a desktop release.
5. **Stripe test mode end to end** against staging: subscribe, upgrade,
   downgrade with host selection, cancel, fail a payment, replay a webhook.
6. **Live mode**: create the live catalogue, portal config and webhook endpoint,
   put the live keys on the box, then flip `SPAWN_BILLING_ENABLED=true`.
7. Watch `invoice.finalization_failed` and the reconciliation job's first runs.

Rollback is flipping the flag back to `false`: the limit disappears, the UI
disappears, and nothing in the schema needs reverting. That is the main reason
the flag exists in this shape.

---

## 11. Open decisions and deliberate omissions

### 11.1 Cancelling while over the limit — decided

**The user must select which hosts to keep, or keep none.** Settled by the
owner; specified in §5.7.

The reconciliation modal is non-dismissible until a choice is made, and it ships
on web, desktop **and mobile** — releasing hosts is host management, not
commerce, so there is no store-policy obstacle and no user is stranded on a
phone.

Two properties this buys, worth preserving through any future refactor:

1. **No host is ever deleted except by an explicit human selection.** The server
   never releases a machine on a billing signal alone, which keeps billing out
   of the one code path in this product that destroys something a person
   depends on.
2. **No suspend state is needed** — no `Host.suspended_at`, no quota refusal in
   `ws/daemon.py`, and therefore no new WebSocket close code (§8.1). The excess
   is resolved by the user, not by the server holding machines hostage.

The cost is that an account which never opens the app again keeps its hosts
running. That is bounded and acceptable: the moment anyone touches any client,
the choice is forced.

### 11.2 Deliberately not built

- **No host suspension.** No `suspended` column, no daemon-side quota refusal.
  §8.1 explains what that avoided.
- **No trials.** The free tier is the trial. Skipping them removes `trialing`,
  `trial_will_end`, `paused` and the whole payment-method-at-trial-end problem.
- **No annual pricing, no seats, no metered usage.** Yearly prices on the same
  three products would be legal later (different interval), but decide the shape
  before creating live-mode objects.
- **No Stripe Entitlements and no reliance on Stripe price metadata.** The
  price→limit map lives in our code, reviewed in git (§3.4).
- **No Stripe Pricing Table.** It cannot host an intermediate step, and our users
  are already authenticated when they upgrade.

### 11.3 A divergence from the obvious integration, on purpose

The standard advice is: let the Customer Portal handle plan switching. We are
disabling it there and owning the plan-change UI. That is more code, and it is
the only way to run your host-selection step before a downgrade lands — the
portal never consults us. §5.6.

### 11.4 Risks to keep in view

| Risk | Mitigation |
|---|---|
| Concurrent pairing races past the limit | Per-user `FOR UPDATE` lock, proven by the SQLite/Postgres test pair (§4.5) |
| Old daemons print a raw error code | Primary gate at `/device/approve`; daemon copy added; auto-update carries it (§8.2) |
| Webhook missed past Stripe's 3-day retry | Reconciliation job (§4.6.3) |
| Silent revenue loss from uncollectable invoices | Subscribe to `invoice.finalization_failed` and alert (§4.6.1) |
| Account deleted, card still billed | Explicit cancel in `delete_account` (§4.9) |
| `/api/me` schema change bricks mobile launch | Optional/defaulted fields only (§6.2) |
| An "upgrade" link creeps into mobile | Test asserts no price string and no billing link while the flag is off (§9.3) |
| A self-hosted install shows billing UI | `billing_enabled` defaults false; routes 404; a dedicated e2e case (§9.2) |
| `SPAWN D` written as "spawn" or the tier as bare "Legion" | Copy review; §1.1 |

---

## 12. Surface inventory

The checklist. Every surface that touches this feature, and what it does.

### Server
| Surface | Change |
|---|---|
| `config.py` | 7 settings + a refuse-to-boot validator |
| `models.py` | `Subscription`, `StripeEvent`, `User.host_limit_override` |
| `alembic/versions/0068_billing.py` | additive tables + column |
| `billing.py` *(new)* | tiers, entitlement, counting, `may_add_host` |
| `billing_stripe.py` *(new)* | the only module importing `stripe` |
| `routes/billing.py` *(new)* | state, checkout, portal, change-plan, webhook |
| `routes/device.py:801` | **primary gate** (402 `host_limit`) |
| `routes/device.py:509` | **backstop gate** (`{"error": "host_limit"}`) |
| `routes/device.py:373` | terminal-status set |
| `routes/auth.py:184` | cancel the subscription before deleting the user |
| `routes/auth_config.py` | advertise the billing block |
| `routes/profile.py` | per-account plan/usage |
| `routes/admin.py` | `host_limit_override` read + write |
| `schemas.py:383`, `:508`, `:1022`, `UserOut` | new shapes and the new poll error |
| `main.py` | register the router; start the reconciliation loop |
| `mail.py` / `email_templates.py` | six billing emails |
| `server/CLAUDE.md` | new modules named (guard-enforced) |

### Web
| Surface | Change |
|---|---|
| `app/pricing/page.tsx` *(new)* | four tiers, pressroom chrome |
| `app/terms/page.tsx`, `app/privacy/page.tsx` *(new)* | **blocking** for Stripe + both app stores |
| `components/brand/press.tsx:134,151,209` | `Masthead`/`Colophon` links (`inShell`-guarded) |
| `components/settings/SubscriptionPanel.tsx` *(new)* | status + actions |
| `components/settings/SettingsDialog.tsx:41,62,109` | tab, a11y description, render |
| `components/settings/settings-dialog-store.ts:14` | `SettingsTab` |
| `components/hosts/connect-host.tsx:1069` | **the hard block + CTA** (all 3 routes) |
| `lib/pairing-errors.ts:3,10,24` | `host_limit` code + copy |
| `app/legion/page.tsx:70,92,122,141` | soft at-capacity states |
| plan-change + host-selection flow *(new)* | §5.6 — shipped as `components/settings/plan-change-dialog.tsx` with `components/hosts/host-keep-picker.tsx` and `components/hosts/host-limit-reconciliation.tsx`, all in directories `web/CLAUDE.md` already names |
| `app/admin` | comp control |
| `tests/e2e/app-mocks.ts:1848`, `settings-modal.spec.ts:3` | eight tabs; rename the spec |

### Mobile
| Surface | Change |
|---|---|
| `app/(drawer)/(tabs)/settings/subscription.tsx` *(new)* | read-only status |
| `components/settings/settings-inventory.ts:22` | panel definition + `controls` |
| `app/(drawer)/_layout.tsx:23` | `APP_ROUTE_MAP` |
| `components/onboarding/host-pairing-step.tsx:254` | limit copy |
| `components/onboarding/install-instructions.tsx:76` | pre-empt copy |
| `data/api/schemas/auth.ts:50` | the billing block **with `.default(false)`**; `tiers` deliberately not parsed |
| `UserOut` schema | optional subscription fields (launch-path safety) |
| `__tests__/route-map.test.ts`, `panel-behavior.test.tsx` | updated |

### Desktop
| Surface | Change |
|---|---|
| `src/main.ts:1360` | **entitlement check before auto-possession** |
| `src/main.ts:1122`, `:1128`, `:857` | try-again, `--new-account`, terminal panel |
| `src/main.ts:962` | plan line in settings |
| `src-tauri/src/lib.rs:366` | `subscription_state`, `open_upgrade` commands |
| product face | inherits `web/` — no work |

### Daemon
| Surface | Change |
|---|---|
| `src/login.rs:333` | a `host_limit` arm before the catch-all |
| everything else | **unchanged** — no close code, no quota handling (§8.1) |

### Docs
| Surface | Change |
|---|---|
| `docs/TRUST.md:116` | billing added to the metadata inventory (§3.6) |
| `docs/RELEASE.md` | the billing flag in the deploy sequence |
| `.env.example` | commented Stripe block |
| `server/CLAUDE.md` | new modules |
