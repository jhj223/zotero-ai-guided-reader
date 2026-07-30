# WeChat Static QR Receipt Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tested server-side flow that creates uniquely priced orders from
the merchant's static WeChat collection QR, accepts only Ed25519-signed merchant
PC receipt events, and grants the existing signed entitlement exactly once.

**Architecture:** Extend the existing payment provider contract with an explicit
provider kind and direct QR image output. Keep unique-cent allocation and receipt
matching inside SQLite `BEGIN IMMEDIATE` transactions. A `StaticQrBridge`
verifies signed heartbeat/receipt requests, while the existing licensing domain
continues to own entitlement extension.

**Tech Stack:** Node.js 24, TypeScript 5.9, `node:http`, `node:crypto`,
`node:sqlite`, Node test runner, existing RSA entitlement signing.

---

## Scope

This plan implements Phase 1 of
`docs/superpowers/specs/2026-07-30-wechat-static-qr-receipt-design.md`:

- static QR provider configuration and image validation;
- unique-cent order allocation with a 48-hour reservation;
- signed watcher heartbeat and availability gating;
- signed receipt validation, replay protection and unique-order matching;
- server routes, main-process wiring, tests and service documentation.

It does not implement Windows UI Automation, receipt text parsing, DPAPI,
watcher packaging, startup registration or a real payment. Those belong to
Phases 2–4.

## File Map

- Modify `services/licensing/src/config.ts`: parse the third provider and its
  image/public-key configuration.
- Modify `services/licensing/src/payments/provider.ts`: expose provider kind and
  support a validated QR data URL.
- Create `services/licensing/src/payments/staticQr.ts`: validate/read the static
  QR asset and return it without generating a replacement QR.
- Create `services/licensing/src/payments/staticQrBridge.ts`: verify merchant
  request signatures, process heartbeats and receipts.
- Modify `services/licensing/src/database.ts`: migrate order metadata and add
  amount reservations, receipt replay tables and watcher health.
- Modify `services/licensing/src/domain.ts`: select unique amounts for static QR
  orders and expose receipt recording.
- Modify `services/licensing/src/server.ts`: availability in catalog, static QR
  order response, signed heartbeat and receipt routes.
- Modify `services/licensing/src/main.ts`: construct provider/bridge from
  restricted files.
- Modify existing providers to declare their kind.
- Add focused tests in `services/licensing/test/`.
- Modify `services/licensing/README.md`: document configuration and the fact
  that this is not an official WeChat order API.

### Task 1: Static QR Configuration and Provider Contract

**Files:**

- Modify: `services/licensing/src/config.ts`
- Modify: `services/licensing/src/payments/provider.ts`
- Modify: `services/licensing/src/payments/sandbox.ts`
- Modify: `services/licensing/src/payments/wechatNative.ts`
- Create: `services/licensing/src/payments/staticQr.ts`
- Modify: `services/licensing/test/config.test.ts`
- Modify: `services/licensing/test/payments.test.ts`

- [ ] **Step 1: Write failing configuration and image tests**

Add a production config test with:

```ts
const config = loadConfig({
  ...productionBase,
  PAYMENT_PROVIDER: "wechat-static-qr",
  WECHAT_STATIC_QR_IMAGE_PATH: "D:/secrets/wechat-qr.png",
  RECEIPT_WATCHER_KEYS_JSON:
    '{"merchant-pc-01":"D:/secrets/merchant-pc-01.pub.pem"}',
});
assert.equal(config.paymentProvider, "wechat-static-qr");
assert.equal(config.staticQr.imagePath, "D:/secrets/wechat-qr.png");
```

Add provider tests that accept PNG/JPEG magic bytes, reject a non-image and a
payload over 2 MiB, and expect:

```ts
assert.deepEqual(await provider.createPayment(input), {
  providerOrderId: input.orderId,
  qrDataUrl: "data:image/png;base64,...",
});
```

- [ ] **Step 2: Run focused tests and verify the missing provider fails**

Run:

```powershell
npm --prefix services/licensing test -- --test-name-pattern "static QR|watcher keys"
```

Expected: FAIL because `wechat-static-qr`, `StaticQrPaymentProvider` and
`qrDataUrl` do not exist.

- [ ] **Step 3: Implement the provider union and strict configuration**

Use this provider contract:

```ts
export type PaymentProviderKind =
  | "sandbox"
  | "wechat-native"
  | "wechat-static-qr";

export type CreatedPayment =
  | { providerOrderId: string; codeUrl: string; qrDataUrl?: never }
  | { providerOrderId: string; qrDataUrl: string; codeUrl?: never };

export interface PaymentProvider {
  readonly kind: PaymentProviderKind;
  createPayment(input: PaymentOrderInput): Promise<CreatedPayment>;
}
```

The static provider constructor accepts an already validated data URL. Export
`loadStaticQrDataUrl(path)` that reads at most `2 * 1024 * 1024 + 1` bytes,
checks the PNG or JPEG magic bytes and returns a `data:image/...;base64,` URL.
Do not accept SVG, client paths or arbitrary MIME strings.

The config branch requires:

```text
WECHAT_STATIC_QR_IMAGE_PATH
RECEIPT_WATCHER_KEYS_JSON
```

The key map uses the existing strict key-ID pattern and requires at least one
non-empty file path.

- [ ] **Step 4: Run focused tests and verify they pass**

Run:

```powershell
npm --prefix services/licensing test -- --test-name-pattern "static QR|watcher keys"
```

Expected: the new provider/config tests PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add services/licensing/src/config.ts `
  services/licensing/src/payments/provider.ts `
  services/licensing/src/payments/sandbox.ts `
  services/licensing/src/payments/wechatNative.ts `
  services/licensing/src/payments/staticQr.ts `
  services/licensing/test/config.test.ts `
  services/licensing/test/payments.test.ts
git commit -m "feat(payments): add static QR provider"
```

### Task 2: Atomic Unique-Cent Allocation

**Files:**

- Modify: `services/licensing/src/database.ts`
- Modify: `services/licensing/src/domain.ts`
- Modify: `services/licensing/test/domain.test.ts`

- [ ] **Step 1: Write failing allocation tests**

Create 100 `wechat-static-qr` monthly orders and assert:

```ts
assert.deepEqual(
  orders.map((order) => order.amountFen),
  Array.from({ length: 100 }, (_, suffix) => 1990 + suffix),
);
assert.throws(
  () =>
    service.createOrder("device-overflow", "pro_monthly", "wechat-static-qr"),
  /PAYMENT_SLOTS_BUSY/,
);
```

Advance the clock beyond 48 hours and assert the first amount can be reused.
Also assert `sandbox` and `wechat-native` orders retain the exact catalog price.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
npm --prefix services/licensing test -- --test-name-pattern "unique|slots"
```

Expected: FAIL because order provider/base/reservation fields and unique
allocation do not exist.

- [ ] **Step 3: Add schema migration and transactional allocation**

Extend `StoredOrder` with:

```ts
provider: PaymentProviderKind;
baseAmountFen: number;
amountReservedUntil: number;
```

New databases create these columns directly. Existing databases use
`PRAGMA table_info(orders)` followed by idempotent `ALTER TABLE` statements:

```sql
provider TEXT NOT NULL DEFAULT 'legacy'
base_amount_fen INTEGER
amount_reserved_until INTEGER
```

Backfill nullable numeric values from `amount_fen` and `expires_at`.

For `wechat-static-qr`, run the selection and insert inside one
`BEGIN IMMEDIATE` transaction. Try suffixes `0..99` and reject any amount used
by another static QR order whose `amount_reserved_until > createdAt`. Reserve
the chosen amount for exactly 48 hours. Other providers insert the base price.

Change the domain signature to:

```ts
createOrder(
  deviceId: string,
  planId: PaidPlanId,
  provider: PaymentProviderKind = "sandbox",
): CreatedOrder
```

- [ ] **Step 4: Run domain tests and verify they pass**

Run:

```powershell
npm --prefix services/licensing test -- --test-name-pattern "orders|unique|slots"
```

Expected: new and existing order-domain tests PASS.

- [ ] **Step 5: Commit Task 2**

```powershell
git add services/licensing/src/database.ts `
  services/licensing/src/domain.ts `
  services/licensing/test/domain.test.ts
git commit -m "feat(payments): reserve unique receipt amounts"
```

### Task 3: Signed Merchant Bridge and Receipt Matching

**Files:**

- Create: `services/licensing/src/payments/staticQrBridge.ts`
- Modify: `services/licensing/src/database.ts`
- Modify: `services/licensing/src/domain.ts`
- Create: `services/licensing/test/staticQrBridge.test.ts`

- [ ] **Step 1: Write failing signature and replay tests**

Generate an Ed25519 key pair and sign:

```text
POST
/v1/merchant/receipts
<unix timestamp>
<base64url nonce>
<sha256 raw body base64url>
```

Tests must prove:

- valid heartbeat updates availability;
- body, path, timestamp, nonce or key-ID tampering is rejected;
- a valid receipt matches exactly one pending static order by integer amount and
  paid-at window;
- duplicate event ID, sequence, fingerprint or nonce never extends twice;
- wrong amount, expired payment or multiple candidates stays unmatched;
- watcher health older than 120 seconds is unavailable.

- [ ] **Step 2: Run the new bridge test and verify it fails**

Run:

```powershell
npm --prefix services/licensing test -- --test-name-pattern "merchant bridge|receipt"
```

Expected: FAIL because bridge APIs and receipt tables are absent.

- [ ] **Step 3: Add strict verification and database operations**

Use Ed25519 through Node `verify(null, data, publicKey, signature)`. Require:

```ts
const RECEIPT_SCHEMA = "wechat-commercial-receipt/v1";
const MAX_CLOCK_SKEW_SECONDS = 300;
const ORDER_TIME_SKEW_MS = 2 * 60 * 1000;
```

Parse heartbeat and receipt bodies by exact key allowlists. Validate all IDs,
UTC timestamps, `CNY`, safe integer cents, sequence and
`sha256:<64 lowercase hex>` fingerprint.

Add strict tables:

```sql
receipt_events(
  event_id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  message_fingerprint TEXT NOT NULL UNIQUE,
  amount_fen INTEGER NOT NULL,
  paid_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  matched_order_id TEXT,
  status TEXT NOT NULL,
  UNIQUE(key_id, sequence)
);
receipt_nonces(
  key_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(key_id, nonce_hash)
);
watcher_status(
  key_id TEXT PRIMARY KEY,
  watcher_version TEXT NOT NULL,
  state TEXT NOT NULL,
  outbox_pending INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
```

Receipt recording is one transaction: insert nonce, detect an exact replay,
insert event, find candidate static orders, and call the existing entitlement
extension only when exactly one candidate exists. Use
`static_qr_<eventId>` as the internal transaction ID.

- [ ] **Step 4: Run bridge and full licensing tests**

Run:

```powershell
npm --prefix services/licensing test
```

Expected: all licensing tests PASS with zero failures.

- [ ] **Step 5: Commit Task 3**

```powershell
git add services/licensing/src/payments/staticQrBridge.ts `
  services/licensing/src/database.ts `
  services/licensing/src/domain.ts `
  services/licensing/test/staticQrBridge.test.ts
git commit -m "feat(payments): verify signed receipt events"
```

### Task 4: HTTP Routes and Runtime Wiring

**Files:**

- Modify: `services/licensing/src/server.ts`
- Modify: `services/licensing/src/main.ts`
- Modify: `services/licensing/test/server.test.ts`
- Create: `services/licensing/test/staticQrServer.test.ts`

- [ ] **Step 1: Write failing HTTP integration tests**

Construct a static provider and bridge with test keys. Assert:

```ts
assert.deepEqual((await catalog.json()).payment, {
  provider: "wechat-static-qr",
  available: false,
  reason: "PAYMENT_WATCHER_OFFLINE",
});
```

Send a signed heartbeat, create a monthly order and assert the response contains
the configured `qrDataUrl`, `baseAmountFen: 1990` and a unique `amountFen`.
Send a signed receipt and poll the order until it contains one entitlement.
Assert stale heartbeat returns `503 PAYMENT_WATCHER_OFFLINE`.

- [ ] **Step 2: Run the server test and verify it fails**

Run:

```powershell
npm --prefix services/licensing test -- --test-name-pattern "static QR server"
```

Expected: FAIL because the catalog metadata and merchant routes do not exist.

- [ ] **Step 3: Implement routes and provider-specific QR rendering**

Pass `dependencies.paymentProvider.kind` into `createOrder`. Before creating a
static order, require `staticQrBridge.availability(now()).available`.

For created payments:

```ts
const qrDataUrl =
  "qrDataUrl" in payment
    ? payment.qrDataUrl
    : await renderCodeUrlAsQr(validatePaymentCodeUrl(payment.codeUrl));
```

Add:

```text
POST /v1/merchant/heartbeat
POST /v1/merchant/receipts
```

Both read raw JSON with a 16 KiB limit and delegate signature verification to
the bridge. Return generic 401 for any signature failure. A valid unmatched
receipt returns accepted status without an entitlement.

In `main.ts`, load watcher public keys and the QR image only for
`wechat-static-qr`; instantiate one bridge shared by the catalog, order and
merchant routes.

- [ ] **Step 4: Run server tests, build and lint**

Run:

```powershell
npm --prefix services/licensing test
npm --prefix services/licensing run build
npm exec prettier -- --check "services/licensing/**/*.{ts,md,json}"
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit Task 4**

```powershell
git add services/licensing/src/server.ts `
  services/licensing/src/main.ts `
  services/licensing/test/server.test.ts `
  services/licensing/test/staticQrServer.test.ts
git commit -m "feat(payments): expose merchant receipt bridge"
```

### Task 5: Documentation, Regression and Phase Review

**Files:**

- Modify: `services/licensing/README.md`
- Modify:
  `docs/superpowers/specs/2026-07-30-wechat-static-qr-receipt-design.md`

- [ ] **Step 1: Correct the reservation wording**

Document that an amount must be unique across all unexpired static QR
reservations, not merely within one base-price group. This closes a collision
when two configured base prices are fewer than 100 fen apart.

- [ ] **Step 2: Document deployment without secrets**

Add example variable names and placeholder paths for:

```text
PAYMENT_PROVIDER=wechat-static-qr
WECHAT_STATIC_QR_IMAGE_PATH=<restricted path>
RECEIPT_WATCHER_KEYS_JSON=<key-id to public-key path map>
```

State explicitly that no watcher is implemented in Phase 1, production orders
remain unavailable without a fresh signed heartbeat, and the real QR/private
keys must stay outside Git.

- [ ] **Step 3: Run complete fresh verification**

Run:

```powershell
npm run license:test
npm run license:build
npm run test
npm run lint:check
npm run build
git diff --check
```

Expected: every command exits 0 and all test summaries report zero failures.

- [ ] **Step 4: Review security-relevant staged diff**

Run:

```powershell
git diff --check
git status --short
rg -n -i "PRIVATE KEY|API[_-]?KEY\s*[:=]|secret\s*[:=]" `
  services/licensing docs/superpowers
```

Inspect every match and confirm no real QR, key, token, database, cache or log
is staged.

- [ ] **Step 5: Obtain one focused Claude review and independently verify**

Give Claude only the Phase 1 spec, plan, changed files, fresh test output and
the security invariants. Ask for blocking correctness/security findings.
Implement in-scope blocking findings, rerun the affected tests and then rerun
the complete verification commands.

- [ ] **Step 6: Commit documentation and any review fixes**

```powershell
git add services/licensing/README.md `
  docs/superpowers/specs/2026-07-30-wechat-static-qr-receipt-design.md `
  services/licensing
git commit -m "docs(payments): document receipt bridge deployment"
```

## Phase 1 Exit Criteria

- Static QR orders cannot be created without a fresh signed watcher heartbeat.
- Every static order receives an amount unique across the 48-hour reservation
  window, or fails closed when all 100 candidate suffixes are busy.
- Only a valid Ed25519-signed receipt can transition one matching order to paid.
- Replayed or ambiguous receipts never extend an entitlement.
- The real QR and private keys remain outside Git and XPI.
- All existing sandbox, official WeChat Native, entitlement and plugin tests
  still pass.
- The implementation is described as a tested server bridge, not as a
  completed real-WeChat integration.
