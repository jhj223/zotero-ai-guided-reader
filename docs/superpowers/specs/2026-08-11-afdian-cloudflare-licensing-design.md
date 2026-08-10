# Afdian Cloudflare Licensing Design

**Date:** 2026-08-11

## Goal

Provide automatic Pro activation for the existing Zotero AI Guided Reader
plugin after an Afdian payment, without requiring a business payment merchant
account, a merchant phone watcher, or automatic recurring debit.

The supported products are:

- `pro_monthly`: CNY 5.90, grants 30 days.
- `pro_yearly`: CNY 49.00, grants 365 days.
- A new installation retains the existing seven-day trial.

## Chosen Approach

Deploy a Cloudflare Worker backed by D1 as the production licensing endpoint.
Keep `services/licensing` intact as the Node/SQLite development and alternate
merchant-provider implementation. The Worker preserves the existing public
license API so the plugin can switch endpoints through the existing commercial
build configuration.

This approach is preferred over a free Render Node deployment because a free
Render service sleeps and cannot persist a local SQLite database. Cloudflare
Workers and D1 are always-on within their free quotas and can later move to the
paid Workers plan without changing the plugin protocol.

## Components

### Cloudflare licensing Worker

Create `services/licensing-worker` with one Worker entry point and focused
modules for configuration, D1 persistence, entitlement signing, Afdian API
access, webhook verification, and HTTP routing.

It exposes the existing endpoints:

- `GET /healthz`
- `GET /v1/about`
- `GET /v1/catalog`
- `POST /v1/trials`
- `POST /v1/orders`
- `GET /v1/orders/:orderId`
- `POST /v1/entitlements/refresh`

It adds:

- `POST /v1/webhooks/afdian`
- a scheduled reconciliation handler for recently pending Afdian orders

The API continues returning structured errors. Unknown routes and malformed
input fail closed. Production responses never include provider secrets,
internal exceptions, database details, or raw Afdian payloads.

### D1 persistence

D1 stores orders, entitlements, processed provider transactions, trial state,
and bounded rate-limit counters. Public identifiers and polling tokens are
cryptographically random. Polling tokens are stored as SHA-256 digests.

Payment completion uses conditional writes and a unique Afdian transaction
identifier. A replay or concurrent delivery cannot extend an entitlement more
than once. The reconciliation path uses the same completion operation as the
webhook path.

### Afdian checkout

Creating an order selects the server-owned plan configuration and creates an
opaque local order. The Worker returns an HTTPS checkout URL in this form:

```text
https://ifdian.net/order/create?plan_id=<configured-plan>&product_type=0&custom_order_id=<opaque-local-order>
```

The plugin never submits a price. The Afdian plan itself controls the displayed
price, while the Worker verifies the paid amount independently.

The order response adds `checkoutUrl`. `qrDataUrl` becomes optional so existing
QR providers remain compatible. The plugin validates that an Afdian checkout
uses HTTPS and an allowlisted Afdian host before handing it to
`Zotero.launchURL`. The payment panel presents an explicit “打开爱发电付款”
button, continues automatic polling, and states that payment is not an
automatic renewal.

## Payment Verification Flow

1. The plugin requests a monthly or yearly order using its local device ID.
2. The Worker creates an opaque order and returns its poll token and Afdian
   checkout URL containing `custom_order_id`.
3. The user completes payment on Afdian.
4. Afdian sends its signed webhook. The Worker verifies the documented
   RSA-SHA256 signature before reading the event as a payment signal.
5. The Worker calls Afdian `query-order` using the server-only user ID and API
   token. The API request uses Afdian's documented MD5 request signature.
6. The queried order must exactly match all of the following:
   - webhook `out_trade_no`;
   - local `custom_order_id`;
   - configured Afdian `plan_id` for the local plan;
   - server-owned amount (`5.90` or `49.00`);
   - successful status `2`;
   - regular subscription product type `0`.
7. Only then does one atomic/idempotent completion operation extend the
   entitlement and mark the local order paid.
8. Plugin polling receives a signed entitlement token and activates Pro.

Webhook failure does not grant access. If a valid webhook is delayed or missed,
polling and the scheduled reconciliation handler query Afdian and invoke the
same verified completion path.

## Entitlement Compatibility

Worker-issued entitlement tokens preserve the existing `ZGAI-ENT` RS256
format, claims, issuer, audience, key ID, 30-day maximum offline window, and
device binding. Cross-runtime tests verify that a token issued with Web Crypto
is accepted by the existing plugin verifier.

The RSA private key is imported from a Cloudflare secret. Only the matching
public JWK is embedded in commercial plugin builds.

## Configuration and Secrets

Non-secret Worker variables:

- `LICENSE_ISSUER`
- `LICENSE_AUDIENCE`
- `LICENSE_KEY_ID`
- `SOURCE_URL`
- `AFDIAN_USER_ID`
- `AFDIAN_MONTHLY_PLAN_ID`
- `AFDIAN_YEARLY_PLAN_ID`

Cloudflare secrets:

- `LICENSE_PRIVATE_KEY_PEM`
- `AFDIAN_API_TOKEN`
- `RATE_LIMIT_PEPPER`

The rotated Afdian token is entered only through Cloudflare secret management.
It must not appear in chat, Git, Wrangler configuration, build output, logs,
D1, or the XPI. Configuration validation rejects missing, malformed, or
placeholder production values.

## Security Controls

- HTTPS-only public and checkout URLs.
- Fixed Afdian API and checkout origins; external redirects are rejected.
- Strict JSON size, content-type, field, length, enum, and money validation.
- RSA-SHA256 webhook signature verification using the documented Afdian public
  key.
- Mandatory Afdian API re-query before activation.
- Exact plan, amount, local-order, provider-order, status, and product checks.
- Unique provider transaction processing and conditional order completion.
- Hashed polling tokens and device/source rate limits.
- Constant-time comparison for locally computed secret-derived values.
- No access grant on timeouts, malformed responses, signature failures,
  provider errors, ambiguous matches, or D1 failures.
- Minimal security headers and no permissive CORS.
- Logs contain opaque event IDs and error categories, never tokens, payment
  payloads, device IDs, entitlement tokens, or private keys.

These controls reduce casual copying and forged activation. They do not claim
that a client-side Zotero extension is impossible to patch; the enforceable
boundary is the server-issued signed entitlement and server-controlled paid
workflow.

## Testing

Worker tests cover:

- configuration and URL allowlists;
- Afdian request signing and API response validation;
- valid and invalid webhook signatures;
- wrong plan, amount, order, status, and product type;
- duplicate webhook and reconciliation idempotency;
- trial uniqueness and paid-extension rules;
- polling-token authorization;
- entitlement signing and compatibility with the plugin verifier;
- checkout UI validation and external navigation;
- complete monthly and yearly payment flows using mocked Afdian responses.

Verification includes Worker tests, existing licensing tests, root tests,
linting, plugin build, secret scans, a local Wrangler/D1 smoke test, and one
focused final review before production deployment.

## Deployment and Rollout

1. Create the D1 database and apply committed migrations.
2. Deploy the Worker with placeholder-free non-secret configuration.
3. Enter the rotated Afdian API token and RSA signing key through Wrangler
   secret prompts or the Cloudflare dashboard; the values are never echoed.
4. Configure the deployed HTTPS `/v1/webhooks/afdian` URL in Afdian and send the
   built-in test notification.
5. Build the commercial XPI with the Worker URL and public entitlement key.
6. Perform one real monthly small-payment acceptance test before public sale.
7. Keep the previous XPI available for rollback and retain the Node service as
   an alternate deployment path.

Production is not described as live until the Cloudflare deployment, Afdian
webhook test, and a real payment-to-entitlement round trip have all succeeded.

## Official Sources

- Afdian Webhook and API documentation:
  <https://afdian.com/p/9c65d9cc617011ed81c352540025c377>
- Afdian checkout URL parameters:
  <https://afdian.com/p/010ff078177211eca44f52540025c377>
- Cloudflare Workers pricing and limits:
  <https://developers.cloudflare.com/workers/platform/pricing/>
- Cloudflare D1 overview and pricing:
  <https://developers.cloudflare.com/d1/>
  <https://developers.cloudflare.com/d1/platform/pricing/>
- Render free-service persistence limitations:
  <https://render.com/docs/free>
