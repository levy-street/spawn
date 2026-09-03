# Stripe setup — what you have to do

`docs/BILLING.md` is the design. This is the operator's side: the short list of
things only you can do, and the values that come back.

**Test mode is already done.** It was provisioned into the `Spawnd dev` account
(`acct_1UAK88S93qMgpg7z`) by `scripts/stripe-provision.sh`, which creates only
new objects and never touches an account setting. §1 records what exists so you
can check it; §2 and §3 are the parts still waiting on you.

---

## 1 · What already exists in test mode

Nothing to do here. Verify it if you want to; otherwise skip to §2.

| Product | Price | Lookup key | Price ID |
|---|---|---|---|
| `SPAWN D — Coven` | $5.00 / month | `spawnd_coven_monthly` | `price_1UAKEFS93qMgpg7zAFPgHeC0` |
| `SPAWN D — Legion` | $20.00 / month | `spawnd_legion_monthly` | `price_1UAKEHS93qMgpg7zcxYWNcWV` |
| `SPAWN D — Pandemonium` | $50.00 / month | `spawnd_pandemonium_monthly` | `price_1UAKEJS93qMgpg7zdBwSQzBu` |

All three are separate Products with one monthly USD price each — the Customer
Portal cannot offer two prices that share a product and a billing interval, and
one product with three prices would break plan switching. All three carry
`tax_behavior=exclusive`, set identically at creation because it is immutable
afterwards and the Portal refuses a switch between prices whose values differ.

- **Customer Portal** `bpc_1UAKEKS93qMgpg7zwEDwIxnL` — invoice history on,
  payment-method update on, cancel-at-period-end on with reason collection, and
  **plan switching off**. That last one is deliberate and load-bearing: the
  Portal would let someone downgrade without ever telling us, leaving them over
  their host limit with no chance to choose which machines to keep. We own the
  plan-change UI so the host-selection step runs first.
- **Webhook** `we_1UAKELS93qMgpg7z5SXhyjnQ` → `https://spawnd.dev/api/billing/webhook`,
  on exactly ten events. `invoice.created` is deliberately **not** among them:
  if Stripe cannot get a success response to it, finalising every
  automatic-collection invoice is delayed for up to 72 hours, so subscribing
  would turn a bug in our handler into a fleet-wide billing outage.
- **Upgrade-confirmation Portal** `bpc_1UBNxxS93qMgpg7zVoi8Lbsb` — a second
  configuration with plan switching **on**, used for one thing: the deep-linked
  `subscription_update_confirm` flow, the Stripe-hosted page that shows the
  prorated charge and takes the payment when somebody moves up a plan. Stripe
  refuses that flow under the configuration above, and the flow page carries no
  navigation into the rest of the portal, so switching stays unreachable from
  "Manage billing". `SPAWN_STRIPE_PORTAL_UPGRADE_CONFIGURATION` names it and the
  server refuses to boot with billing on and this unset.
- The values are on this machine at `~/.spawn-stripe.env`, mode 600, outside
  the repo. They are test-mode only.

The whole flow has been exercised against that account end to end: subscribe,
upgrade, downgrade refused while over the limit, hosts released, downgrade
completed, cancel, and the over-limit state that forces the choice. Signature
verification was checked with a wrong secret, a missing header, a stale
timestamp and a tampered body — all refused.

---

## 2 · Three decisions

Only the first is urgent.

1. **The legal pages.** `/terms` and `/privacy` are written and in this branch,
   but both carry a visible **"Pre-launch draft"** banner and bracketed
   placeholders where nothing could honestly be invented:
   `[LEGAL ENTITY NAME]`, `[REGISTERED ADDRESS]`, `[CONTACT ADDRESS]`,
   `[GOVERNING LAW]`, `[JURISDICTION]`, `[LIABILITY CAP]`, `[EFFECTIVE DATE]`,
   `[HOSTING REGION]`, `[TRANSFER MECHANISM]`, `[LOG RETENTION WINDOW]` and
   `[REFUND POLICY]`.

   The repo already names `Dreamhome AI Limited, Wellington, NZ,
   hello@levystreet.com` as the code-signing subject (`docs/RELEASE.md`), which
   is the obvious candidate — but whether that is the *contracting* entity for
   subscriptions is your call, not something to infer from a certificate.

   These are blocking three separate things, and two of them have nothing to do
   with billing: Stripe will not activate without both URLs, App Store Connect
   will not accept a build without the privacy one, and Google Play will not
   accept a listing without it.

2. **Stripe Tax, on or off.** On means Stripe computes and collects VAT and
   sales tax and you register where you cross thresholds; off means the prices
   are what you keep and you carry the liability. For a $5 product selling into
   the EU and UK, on is the safer default and it pairs with the `exclusive` tax
   behaviour already set. It changes no code either way, so it can wait until
   live mode.

3. **The refund position**, for `/terms`. Stripe mandates nothing, but EU and UK
   law gives consumers a 14-day withdrawal right on digital services unless they
   expressly waive it, and the waiver has to be collected at checkout.

---

## 3 · Going live, when you are ready

Live mode is a separate world: different keys, different object ids, and
activation requirements test mode does not have. `scripts/stripe-provision.sh`
**refuses to run against anything but a test-mode key**, on purpose — this part
is done by hand, deliberately.

**In the dashboard, with the toggle set to live:**

1. **Activate the account** — business details and a bank account. Test mode
   needs neither; live mode needs both.
2. **Settings → Business → Public details**: support email, support URL, and a
   statement descriptor. The descriptor is what appears on a card statement, so
   make it recognisably `SPAWND`.
3. **Settings → Business → Legal**: the `/terms` and `/privacy` URLs. Required
   for activation.
4. **Settings → Business → Branding**: logo and accent colour, so Checkout and
   the Portal do not look like a different company.
5. Repeat §1's catalogue, portal configuration and webhook endpoint in live
   mode. Everything else in this file is the same; only the ids change.

**Then send me these five, and nothing else:**

```
SPAWN_STRIPE_SECRET_KEY=sk_live_…
SPAWN_STRIPE_WEBHOOK_SECRET=whsec_…
SPAWN_STRIPE_PRICE_COVEN=price_…
SPAWN_STRIPE_PRICE_LEGION=price_…
SPAWN_STRIPE_PRICE_PANDEMONIUM=price_…
SPAWN_STRIPE_PORTAL_CONFIGURATION=bpc_…          # "Manage billing": switching off
SPAWN_STRIPE_PORTAL_UPGRADE_CONFIGURATION=bpc_…  # the upgrade-confirm flow: switching on
```

- The secret key: **Developers → API keys → Secret key**.
- The webhook secret is shown once, when you create the endpoint.
- The three price ids are on the prices you create in step 5.

**Never paste a live key into a chat, a commit or an issue.** Put it straight
into the server's `.env` on the box. Test-mode keys are safe to share; live keys
can move real money.

There is no publishable key to send, in either mode. Checkout is a
server-created redirect, so no Stripe JavaScript runs in our pages and no Stripe
key ever reaches a browser.

---

## 4 · What happens after that

Nothing you have to do — but so you can see it coming:

`SPAWN_BILLING_ENABLED` stays **false** through every step above, and false
means the billing routes answer 404, no host limit is enforced, and both
frontends render exactly what they render today. So the keys can go on the box,
the server can restart, and nothing changes. Flipping the flag to `true` is the
single act that turns billing on, and flipping it back to `false` is the whole
of the rollback — the limit disappears, the UI disappears, and nothing in the
database needs reverting.

The full deploy order is in `docs/RELEASE.md` under "Billing, and the flag that
makes it a no-op". Two things worth knowing without reading it:

- The server **refuses to boot** with billing on and a missing webhook secret,
  secret key or price id. An endpoint that cannot verify a signature is an
  unauthenticated "make me a paid subscriber" API, and a half-configured
  catalogue is a tier that cannot be bought.
- Watch `invoice.finalization_failed` after go-live. It is the one nobody
  remembers: the subscription stays active but the invoice cannot be collected,
  so it is silent revenue loss with no user-visible symptom.
