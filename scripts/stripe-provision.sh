#!/usr/bin/env bash
set -euo pipefail

# Provision the Stripe catalogue, portal configuration and webhook endpoint for
# SPAWN D billing, and print the five values the server needs.
#
# Everything here is idempotent: it looks an object up before creating it, so a
# second run against the same sandbox changes nothing and reprints the same
# ids. That is what makes it safe to re-run while you are still deciding, and
# what makes live-mode setup a repeat of a command rather than a fresh climb
# through a dashboard.
#
# It deliberately touches NOTHING account-wide. No activation, no business
# details, no bank account, no public details, no legal URLs, no branding. Those
# are settings a Stripe account already has, and a provisioning script that
# rewrote them would be changing something somebody chose. The Customer Portal
# gets its OWN configuration object rather than the account default, for the
# same reason — see PORTAL below.
#
#   STRIPE_API_KEY=sk_test_… scripts/stripe-provision.sh
#
# Optional:
#   SPAWN_WEBHOOK_URL   default https://spawnd.dev/api/billing/webhook
#   SPAWN_TAX_BEHAVIOR  default exclusive; must be identical on all three prices
#                       and is IMMUTABLE once a price exists
#   SPAWN_TERMS_URL / SPAWN_PRIVACY_URL  for the portal configuration

STRIPE_BIN="${STRIPE_BIN:-$HOME/.local/bin/stripe}"
WEBHOOK_URL="${SPAWN_WEBHOOK_URL:-https://spawnd.dev/api/billing/webhook}"
TAX_BEHAVIOR="${SPAWN_TAX_BEHAVIOR:-exclusive}"
TERMS_URL="${SPAWN_TERMS_URL:-https://spawnd.dev/terms}"
PRIVACY_URL="${SPAWN_PRIVACY_URL:-https://spawnd.dev/privacy}"

if [[ ! -x "$STRIPE_BIN" ]]; then
  echo "stripe CLI not found at $STRIPE_BIN — set STRIPE_BIN" >&2
  exit 1
fi
if [[ -z "${STRIPE_API_KEY:-}" ]]; then
  echo "STRIPE_API_KEY is required (sk_test_… or rk_test_… from a sandbox)" >&2
  exit 1
fi

# The guard that makes this script safe to hand to an agent. A live key can
# create real products a real customer can be charged against, and nothing here
# needs that: live mode is a deliberate, separate act.
case "$STRIPE_API_KEY" in
  sk_test_*|rk_test_*) ;;
  *)
    echo "REFUSING: STRIPE_API_KEY is not a test-mode key." >&2
    echo "Live mode is set up deliberately, by hand, not by this script." >&2
    exit 1
    ;;
esac

api() {
  local method="$1" path="$2"; shift 2
  "$STRIPE_BIN" "$method" "$path" --api-key "$STRIPE_API_KEY" "$@"
}

# Read one dotted path out of a JSON object on stdin, printing an empty line
# for anything absent. Absence is the normal case here — "is there already a
# price with this lookup key" answers with an empty list on a fresh account —
# so a missing key must be a value, never a traceback.
jqf() { python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print(""); raise SystemExit
for k in sys.argv[1].split("."):
    if isinstance(d, list):
        i = int(k)
        d = d[i] if 0 <= i < len(d) else None
    elif isinstance(d, dict):
        d = d.get(k)
    else:
        d = None
    if d is None:
        break
print(d if d is not None else "")' "$1"; }

echo "==> Account: $(api get /v1/account 2>/dev/null | jqf id || echo '(restricted key: cannot read account)')"
echo "==> Mode:    test"
echo "==> Tax behavior on every price: $TAX_BEHAVIOR (immutable once set)"
echo

# ---------------------------------------------------------------- catalogue --
# Three separate PRODUCTS, not one product with three prices. The Customer
# Portal cannot offer two prices that share a product and a billing interval,
# which would break plan switching the moment we ever wanted it back.
#
# metadata.host_limit is a convenience for whoever opens the dashboard. The
# server never reads it: the limit comes from our own price-id map in
# spawn_server/billing.py, which is reviewed in git. Stripe metadata is editable
# by anyone with dashboard access and is not an authority.

provision_tier() {
  local key="$1" product_name="$2" amount_cents="$3" lookup_key="$4" host_limit="$5"
  local existing price_id product_id

  existing=$(api get /v1/prices -d "lookup_keys[0]=$lookup_key" -d "limit=1" 2>/dev/null || echo '{"data":[]}')
  price_id=$(printf '%s' "$existing" | jqf "data.0.id")

  if [[ -n "$price_id" ]]; then
    # stderr, not stdout: this function's stdout IS the price id, and a
    # progress line on it would end up inside the value the caller captures.
    echo "  $lookup_key already exists: $price_id" >&2
    printf '%s' "$price_id"
    return
  fi

  product_id=$(api post /v1/products \
    -d "name=$product_name" \
    -d "metadata[host_limit]=$host_limit" \
    -d "metadata[spawn_tier]=$key" | jqf id)

  price_id=$(api post /v1/prices \
    -d "product=$product_id" \
    -d "unit_amount=$amount_cents" \
    -d "currency=usd" \
    -d "recurring[interval]=month" \
    -d "lookup_key=$lookup_key" \
    -d "tax_behavior=$TAX_BEHAVIOR" \
    -d "metadata[host_limit]=$host_limit" | jqf id)

  echo "  created $product_name -> $price_id" >&2
  printf '%s' "$price_id"
}

echo "==> Products and prices"
# 0 means unlimited, the same convention the server uses everywhere.
PRICE_COVEN=$(provision_tier coven       "SPAWN D — Coven"       500  spawnd_coven_monthly       3)
PRICE_LEGION=$(provision_tier legion      "SPAWN D — Legion"      2000 spawnd_legion_monthly      20)
PRICE_PANDE=$(provision_tier pandemonium "SPAWN D — Pandemonium" 5000 spawnd_pandemonium_monthly 0)
echo

# ------------------------------------------------------------------- portal --
# PORTAL: our own configuration object, never the account default.
#
# Plan switching is OFF and that is load-bearing rather than tidy. The portal
# would let somebody downgrade and never consult us, leaving an account holding
# more hosts than the new plan admits with no chance to choose which to keep.
# We own the plan-change UI so the host-selection step runs first; leaving this
# on would give users a second, unguarded downgrade path.
echo "==> Customer Portal configuration"
PORTAL_ID=$(api get /v1/billing_portal/configurations -d "limit=100" 2>/dev/null \
  | python3 -c '
import sys, json
for c in json.load(sys.stdin).get("data", []):
    if c.get("metadata", {}).get("spawn") == "billing":
        print(c["id"]); break
' || true)

if [[ -n "${PORTAL_ID:-}" ]]; then
  echo "  already exists: $PORTAL_ID"
else
  PORTAL_ID=$(api post /v1/billing_portal/configurations \
    -d "metadata[spawn]=billing" \
    -d "business_profile[terms_of_service_url]=$TERMS_URL" \
    -d "business_profile[privacy_policy_url]=$PRIVACY_URL" \
    -d "features[invoice_history][enabled]=true" \
    -d "features[payment_method_update][enabled]=true" \
    -d "features[customer_update][enabled]=true" \
    -d "features[customer_update][allowed_updates][0]=email" \
    -d "features[customer_update][allowed_updates][1]=address" \
    -d "features[subscription_cancel][enabled]=true" \
    -d "features[subscription_cancel][mode]=at_period_end" \
    -d "features[subscription_cancel][cancellation_reason][enabled]=true" \
    -d "features[subscription_cancel][cancellation_reason][options][0]=too_expensive" \
    -d "features[subscription_cancel][cancellation_reason][options][1]=missing_features" \
    -d "features[subscription_cancel][cancellation_reason][options][2]=switched_service" \
    -d "features[subscription_cancel][cancellation_reason][options][3]=unused" \
    -d "features[subscription_cancel][cancellation_reason][options][4]=other" \
    -d "features[subscription_update][enabled]=false" | jqf id)
  echo "  created $PORTAL_ID"
fi
echo

# ------------------------------------------------------------------ webhook --
# Exactly ten events. invoice.created is deliberately NOT among them: if Stripe
# cannot get a success response to it, finalising every automatic-collection
# invoice is delayed for up to 72 hours, so subscribing would convert a bug in
# our handler into a fleet-wide billing outage, for an event we have no use for.
EVENTS=(
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
)

echo "==> Webhook endpoint  $WEBHOOK_URL"
EXISTING_HOOK=$(api get /v1/webhook_endpoints -d "limit=100" 2>/dev/null \
  | python3 -c "
import sys, json
url = sys.argv[1]
for e in json.load(sys.stdin).get('data', []):
    if e.get('url') == url:
        print(e['id']); break
" "$WEBHOOK_URL" || true)

if [[ -n "${EXISTING_HOOK:-}" ]]; then
  echo "  already exists: $EXISTING_HOOK"
  echo "  (a signing secret is returned ONLY at creation — reveal it in the dashboard,"
  echo "   or delete and re-run this script to mint a new endpoint)"
  WEBHOOK_SECRET="(reveal in dashboard for $EXISTING_HOOK)"
else
  args=(-d "url=$WEBHOOK_URL" -d "description=SPAWN D billing")
  i=0
  for ev in "${EVENTS[@]}"; do
    args+=(-d "enabled_events[$i]=$ev")
    i=$((i + 1))
  done
  HOOK_JSON=$(api post /v1/webhook_endpoints "${args[@]}")
  echo "  created $(printf '%s' "$HOOK_JSON" | jqf id)"
  WEBHOOK_SECRET=$(printf '%s' "$HOOK_JSON" | jqf secret)
fi
echo

cat <<OUT
================ put these on the server, and nowhere else ================

SPAWN_STRIPE_SECRET_KEY=$STRIPE_API_KEY
SPAWN_STRIPE_WEBHOOK_SECRET=$WEBHOOK_SECRET
SPAWN_STRIPE_PRICE_COVEN=$PRICE_COVEN
SPAWN_STRIPE_PRICE_LEGION=$PRICE_LEGION
SPAWN_STRIPE_PRICE_PANDEMONIUM=$PRICE_PANDE

Customer Portal configuration: $PORTAL_ID

SPAWN_BILLING_ENABLED stays false until the whole flow has been exercised
end to end. Everything above is inert while it is.
===========================================================================
OUT
