# Afdian Cloudflare Licensing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy an always-on Cloudflare Worker/D1 licensing service that grants the existing Zotero plugin's monthly or yearly Pro entitlement only after a verified Afdian payment.

**Architecture:** Add a separate Worker service so the existing Node/SQLite payment implementations remain stable. The Worker preserves the plugin's current licensing endpoints, adds an Afdian checkout URL and webhook, stores state in D1, treats the webhook only as a minimal query hint even when a signature is present, verifies every payment through the creator-authenticated Afdian query API, and issues the existing RS256 entitlement format. The plugin accepts either the existing QR response or the new allowlisted checkout URL.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers, D1, Hono, Wrangler, Vitest 4 with `@cloudflare/vitest-pool-workers`, Web Crypto/Workers `node:crypto`, React 19, Zotero 9.

---

## File Structure

- `services/licensing-worker/package.json`: isolated Worker scripts and dependencies.
- `services/licensing-worker/wrangler.jsonc`: Worker runtime, D1 binding, cron, and compatibility configuration; no secrets.
- `services/licensing-worker/tsconfig.json`: Worker-only TypeScript configuration.
- `services/licensing-worker/vitest.config.ts`: Workers runtime test pool and D1 migrations.
- `services/licensing-worker/migrations/0001_initial.sql`: indexed order, entitlement, payment-event, trial, and rate-limit tables.
- `services/licensing-worker/src/config.ts`: strict environment and plan mapping validation.
- `services/licensing-worker/src/crypto.ts`: opaque IDs, hashes, constant-time comparison, PEM/JWK helpers, and RS256 entitlement tokens.
- `services/licensing-worker/src/store.ts`: prepared D1 operations and atomic/idempotent payment completion.
- `services/licensing-worker/src/afdian.ts`: checkout URL construction, strict webhook parsing, API request signing, bounded response parsing, and exact payment checks.
- `services/licensing-worker/src/service.ts`: trial, order, poll, refresh, payment, and reconciliation domain operations.
- `services/licensing-worker/src/index.ts`: Hono routes, strict request limits, structured errors, headers, and scheduled handler.
- `services/licensing-worker/test/*.test.ts`: Worker-runtime unit and integration tests.
- `src/runtime/licenseClient.ts`: additive `checkoutUrl` order contract with strict origin validation.
- `src/ui/useLicenseController.ts`: validated checkout navigation action.
- `src/ui/LicensePanel.tsx`: Afdian payment button and provider-neutral copy.
- `test/licenseClient.test.ts`, `test/licenseUi.test.ts`: plugin-side contract and UI tests.
- `.env.example`, `services/licensing-worker/README.md`, `README.md`: secret-free operation and deployment documentation.
- `package.json`, `package-lock.json`: root orchestration scripts only.

### Task 1: Scaffold and Validate the Worker Boundary

**Files:**

- Create: `services/licensing-worker/package.json`
- Create: `services/licensing-worker/tsconfig.json`
- Create: `services/licensing-worker/wrangler.jsonc`
- Create: `services/licensing-worker/vitest.config.ts`
- Create: `services/licensing-worker/src/config.ts`
- Create: `services/licensing-worker/test/config.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing configuration tests**

Cover accepted monthly/yearly amounts, exact Afdian identifier patterns,
HTTPS issuer/source URLs, non-placeholder secrets, and rejection of missing or
malformed values. Use a typed `WorkerEnv` fixture with values that never match
real credentials.

- [ ] **Step 2: Install the isolated dependencies and verify RED**

Run:

```powershell
npm install --prefix services/licensing-worker
npm --prefix services/licensing-worker test -- --run test/config.test.ts
```

Expected: FAIL because `src/config.ts` and the Worker test configuration do not
exist yet.

- [ ] **Step 3: Add the minimal Worker scaffold and strict config parser**

Use Hono for routing, the current Workers module handler format, compatibility
date `2026-08-11`, `nodejs_compat`, a D1 `DB` binding, and one reconciliation
cron. Store no secret or live plan ID in `wrangler.jsonc`. The config parser
returns this contract:

```ts
export interface RuntimeConfig {
  issuer: string;
  audience: string;
  keyId: string;
  sourceUrl: string;
  privateKeyPem: string;
  rateLimitPepper: string;
  afdian: {
    userId: string;
    apiToken: string;
    monthlyPlanId: string;
    yearlyPlanId: string;
  };
}
```

- [ ] **Step 4: Verify GREEN and type generation**

Run:

```powershell
npm --prefix services/licensing-worker test -- --run test/config.test.ts
npm --prefix services/licensing-worker run types
npm --prefix services/licensing-worker run typecheck
```

Expected: configuration tests pass and generated Worker binding types compile.

- [ ] **Step 5: Commit the scaffold**

```text
feat(licensing-worker): scaffold Cloudflare runtime
```

### Task 2: Add D1 State and Entitlement Compatibility

**Files:**

- Create: `services/licensing-worker/migrations/0001_initial.sql`
- Create: `services/licensing-worker/src/crypto.ts`
- Create: `services/licensing-worker/src/store.ts`
- Create: `services/licensing-worker/src/service.ts`
- Create: `services/licensing-worker/test/store.test.ts`
- Create: `services/licensing-worker/test/entitlements.test.ts`

- [ ] **Step 1: Write failing persistence and token tests**

Test seven-day trial uniqueness, random public IDs, SHA-256 polling-token
storage, 30/365-day plan extension, replayed provider transactions, concurrent
conditional completion, and rejection of wrong-device refreshes. Import the
root plugin verifier and prove it accepts a Worker-issued `ZGAI-ENT` RS256
token.

- [ ] **Step 2: Apply the local migration and verify RED**

Run:

```powershell
npm --prefix services/licensing-worker run db:migrate:local
npm --prefix services/licensing-worker test -- --run test/store.test.ts test/entitlements.test.ts
```

Expected: FAIL because the store, service, and signer are not implemented.

- [ ] **Step 3: Implement prepared D1 operations and Web Crypto signing**

Use bound prepared statements only. Store timestamps as integer milliseconds
and money as integer fen. Make `provider_transaction_id` unique and complete a
payment through a D1 atomic batch containing a conditional pending-order
update, event insert, and entitlement upsert. Preserve the existing token header
and claim contract:

```ts
{ alg: "RS256", typ: "ZGAI-ENT", kid: config.keyId }
```

Set `offlineUntil` to the earlier of `validUntil` and 30 days after issuance.

- [ ] **Step 4: Verify GREEN**

Run the two focused test files, then the complete Worker test suite and
typecheck. Expected: all commands exit 0.

- [ ] **Step 5: Commit the state core**

```text
feat(licensing-worker): add D1 entitlement state
```

### Task 3: Implement the Verified Afdian Adapter

**Files:**

- Create: `services/licensing-worker/src/afdian.ts`
- Create: `services/licensing-worker/test/afdian.test.ts`

- [ ] **Step 1: Write failing Afdian protocol tests**

Cover exact checkout URL generation, unsafe host rejection, API MD5 signing,
minimal webhook hint parsing without direct trust, explicit pagination
metadata, response size/content-type limits, invalid JSON, redirects, timeouts,
provider error codes, and exact queried-order matching for both configured plans.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm --prefix services/licensing-worker test -- --run test/afdian.test.ts
```

Expected: FAIL because the adapter is absent.

- [ ] **Step 3: Implement the documented protocol**

Build checkout URLs only on `https://ifdian.net/order/create`, with
`product_type=0`, configured `plan_id`, and opaque `custom_order_id`. Treat the
documented unsigned Webhook only as an order hint. Then query
`https://ifdian.net/api/open/query-order` with:

```ts
sign = md5(token + `params${params}ts${ts}user_id${userId}`);
```

Reject redirects and activate only when the queried event matches the webhook,
local order, configured plan, integer-fen amount, `status === 2`, and
`product_type === 0`.

- [ ] **Step 4: Verify GREEN and outbound-host scanning**

Run the focused tests and confirm `rg` finds only the two fixed Afdian HTTPS
origins in production code.

- [ ] **Step 5: Commit the provider adapter**

```text
feat(payments): verify Afdian orders
```

### Task 4: Expose the Worker API and Reconciliation Flow

**Files:**

- Create: `services/licensing-worker/src/index.ts`
- Create: `services/licensing-worker/test/server.test.ts`
- Create: `services/licensing-worker/test/reconciliation.test.ts`

- [ ] **Step 1: Write failing API integration tests**

Test every existing plugin endpoint, strict method/content-type/body handling,
structured errors, security headers, no permissive CORS, bearer polling,
monthly and yearly checkout responses, verified webhook/query completion, forged and
duplicate webhook rejection, and no secret-bearing response or log value.

- [ ] **Step 2: Verify RED**

Run the server and reconciliation test files. Expected: FAIL because routes and
scheduled handling do not exist.

- [ ] **Step 3: Implement routes and scheduled reconciliation**

Return `checkoutUrl` for Afdian orders and keep the remaining order fields
backward compatible. Webhook success must return Afdian's required JSON
acknowledgement:

```json
{ "ec": 200, "em": "" }
```

The scheduled handler selects a bounded page of recent pending orders, queries
Afdian sequentially with timeouts, and calls the same idempotent completion
operation. It never grants access on provider or database failure.

- [ ] **Step 4: Verify GREEN with local D1**

Run the complete Worker suite, typecheck, Wrangler dry-run, and a local
`wrangler dev` health/catalog smoke test. Expected: all checks exit 0.

- [ ] **Step 5: Commit the Worker API**

```text
feat(licensing-worker): expose Afdian licensing API
```

### Task 5: Add Provider-Neutral Checkout to the Zotero Plugin

**Files:**

- Modify: `src/runtime/licenseClient.ts`
- Modify: `src/ui/useLicenseController.ts`
- Modify: `src/ui/LicensePanel.tsx`
- Modify: `src/ui/GuidedReaderApp.tsx`
- Modify: `test/licenseClient.test.ts`
- Modify: `test/licenseManager.test.ts`
- Modify: `test/licenseUi.test.ts`

- [ ] **Step 1: Write failing plugin contract and UI tests**

Require either a valid image data URL or a valid HTTPS checkout URL. Accept
only `afdian.com` and `ifdian.net` hostnames for Afdian checkout navigation,
reject credentials, non-default ports, fragments, unexpected paths, and all
active URL schemes. Verify the panel shows the Afdian button, provider-neutral
copy, automatic polling, and the existing QR behavior for other providers.

- [ ] **Step 2: Verify RED**

Run the three focused root test files. Expected: FAIL because `checkoutUrl` and
the navigation action do not exist.

- [ ] **Step 3: Implement the additive contract and UI**

Add optional `checkoutUrl` and optional `qrDataUrl` fields with an exclusive
validation rule requiring at least one. Add `openCheckout()` to the controller,
revalidate the URL immediately before `Zotero.launchURL`, and show a clear
button without auto-opening an external page. Keep the manual refresh and
cancel actions.

- [ ] **Step 4: Verify GREEN and build the plugin**

Run focused tests, all root tests, lint, and the XPI build. Expected: every
command exits 0 and the payment panel remains responsive at narrow sidebar
widths.

- [ ] **Step 5: Commit the client change**

```text
feat(licensing): open Afdian checkout securely
```

### Task 6: Document and Prepare Secure Deployment

**Files:**

- Create: `services/licensing-worker/README.md`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/COMMERCIAL_RELEASE_CHECKLIST.md`

- [ ] **Step 1: Add orchestration and secret-free documentation**

Add root scripts for Worker tests, typecheck, local migration, dry-run, and
deployment. Document the Afdian webhook URL, seven secret inputs, key rotation,
D1 backup/Time Travel, rollback, missed-webhook reconciliation, and explicit
production acceptance criteria. Never include a token, private key, live plan
ID, or creator account identifier.

- [ ] **Step 2: Run complete fresh verification**

Run:

```powershell
npm run license:worker:test
npm run license:worker:typecheck
npm run license:worker:dry-run
npm run license:test
npm run license:build
npm test
npm run lint:check
npm run build
npm run licenses:audit -- --offline
npm audit --audit-level=high
npm --prefix services/licensing-worker audit --audit-level=high
git diff --check
```

Expected: all commands exit 0 with no high/critical production vulnerability.

- [ ] **Step 3: Perform the security and secret review**

Inspect the complete diff and built XPI for tokens, private keys, plan IDs,
creator IDs, `.dev.vars`, PEM markers, real payment payloads, and unrestricted
outbound URLs. Confirm all activation paths use the exact same verified,
idempotent completion operation.

- [ ] **Step 4: Obtain one focused final review and independently re-verify**

Provide the design, plan, changed payment files, security invariants, and fresh
test evidence to one strongest available Claude review session. Apply blocking
in-scope findings and rerun affected tests plus the complete verification suite.

- [ ] **Step 5: Commit the deployment preparation**

```text
docs(payments): document Afdian Worker deployment
```

### Task 7: Provision, Deploy, and Perform Live Acceptance

**Files:**

- Modify: `services/licensing-worker/wrangler.jsonc` only when Wrangler writes the provisioned D1 identifier.
- Create outside Git: restricted RSA keys and local deployment input.
- Create ignored: `config/commercial-release.json` for the deployed public URL and public JWK.

- [ ] **Step 1: Verify Cloudflare authentication**

Run `npx --prefix services/licensing-worker wrangler whoami`. If OAuth is not
authenticated, run one interactive `wrangler login` and pause only for the
account owner to approve the browser prompt.

- [ ] **Step 2: Provision D1 and apply the remote migration**

Create `zotero-ai-guided-reader-licensing`, bind the returned database ID,
apply `0001_initial.sql` remotely, and verify the migration list and indexes.

- [ ] **Step 3: Install production secrets without echoing them**

Generate the entitlement RSA key and rate-limit pepper in a restricted folder
outside the repository. Enter the rotated Afdian token and other deployment
values through hidden Wrangler secret prompts. Run `wrangler secret list` to
verify names only.

- [ ] **Step 4: Deploy and verify the public Worker**

Deploy, record the HTTPS workers.dev URL, and verify `/healthz`, `/v1/about`,
`/v1/catalog`, trial issuance, checkout order creation, and rejection of forged
webhooks. Do not print entitlement tokens or checkout custom order values.

- [ ] **Step 5: Configure and test the Afdian webhook**

Enter `<deployed-origin>/v1/webhooks/afdian` in the Afdian developer dashboard,
send its test notification, and verify an acknowledgement without granting a
real entitlement for test data.

- [ ] **Step 6: Build and install the commercial XPI**

Write only the Worker URL, issuer, audience, key ID, and public JWK to the
ignored commercial configuration. Build the XPI, scan it for secrets, install
it into Zotero, and verify the seven-day trial and both checkout buttons.

- [ ] **Step 7: Complete one real monthly payment acceptance test**

Create a fresh monthly order, pay CNY 5.90 through Afdian, verify that the
webhook/query pair marks it paid exactly once, and confirm Zotero receives a
30-day Pro entitlement. Repeat webhook delivery and confirm the expiry does not
extend again. The yearly path is accepted through mocked integration tests
until an intentional CNY 49.00 live purchase is authorized.

- [ ] **Step 8: Commit only non-secret deployment metadata**

Commit the provisioned D1 binding and public documentation/config example only
after a staged secret scan:

```text
chore(deploy): configure Afdian licensing Worker
```

## Exit Criteria

- The rotated Afdian token and entitlement private key exist only in Cloudflare
  secrets and a restricted local backup outside the repository.
- A webhook alone cannot activate Pro; a matching Afdian query is mandatory.
- Duplicate webhook, poll, cron, and concurrent deliveries cannot extend time
  twice.
- Existing QR providers and all existing tests continue to work.
- The deployed Worker, D1 migration, Afdian webhook test, commercial XPI, and
  real monthly payment round trip have current verification evidence.
- Any step requiring the account owner is limited to OAuth approval, hidden
  secret entry, and the real CNY 5.90 payment.
